#!/usr/bin/env python3
"""Safely acquire and grow one OCI Always Free Ampere A1 instance.

The script deliberately supports only VM.Standard.A1.Flex. It re-reads live
tenancy usage before every round, refuses paid shapes and over-quota storage,
and uses deterministic retry tokens. A lower-memory instance remains useful:
the watcher keeps it and continues trying in-place upgrades until it reaches
the 2 OCPU / 12 GB target.
"""

from __future__ import annotations

import argparse
import email.utils
import math
import json
import random
import re
import sys
import time
import uuid
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable, Sequence


SHAPE = "VM.Standard.A1.Flex"
ALLOWED_FREE_BILLING_TYPES = {"ALWAYS_FREE", "LIMITED_FREE"}
LIVE_INSTANCE_STATES = {"MOVING", "PROVISIONING", "RUNNING", "STARTING", "STOPPED", "STOPPING"}
LIVE_VOLUME_STATES = {"PROVISIONING", "RESTORING", "AVAILABLE"}
CAPACITY_MESSAGE = re.compile(r"out of (?:host )?capacity", re.IGNORECASE)
# Any Always Free A1 foothold from 2 GB upward is deployable. A successful
# launch below the 12 GB target remains live while later rounds keep trying
# in-place upgrades; obtaining a smaller host never disables the catcher.
MEMORY_LADDER_GB = (12.0, 11.0, 10.0, 9.0, 8.0, 7.0, 6.0, 5.0, 4.0, 3.0, 2.0)
EVENT_LOG: Path | None = None
# OCI rejects a Compute Capacity Report containing more than ten shape
# configurations. Keep the full ladder, but transport it in lossless batches.
CAPACITY_REPORT_MAX_SHAPE_CONFIGS = 10
DEFAULT_THROTTLE_BACKOFF_SECONDS = 60
# Rotate the append-only event log instead of growing it forever (it reached
# 13.8 MB in five days of one-minute rounds on a 1 GB host).
EVENT_LOG_MAX_BYTES = 8 * 1024 * 1024
MAX_THROTTLE_BACKOFF_SECONDS = 300


@dataclass(frozen=True)
class GuardLimits:
    ocpus: float = 2.0
    memory_gb: float = 12.0
    total_storage_gb: float = 200.0


def emit(event: str, **fields: Any) -> None:
    payload = {
        "time": datetime.now(timezone.utc).isoformat(),
        "event": event,
        **fields,
    }
    line = json.dumps(payload, ensure_ascii=False, default=str)
    if EVENT_LOG is not None:
        EVENT_LOG.parent.mkdir(parents=True, exist_ok=True)
        try:
            if EVENT_LOG.stat().st_size > EVENT_LOG_MAX_BYTES:
                EVENT_LOG.replace(EVENT_LOG.with_name(EVENT_LOG.name + ".1"))
        except FileNotFoundError:
            pass
        with EVENT_LOG.open("a", encoding="utf-8") as stream:
            stream.write(line + "\n")
    if sys.stdout is not None:
        print(line, flush=True)


def is_live_instance(instance: Any) -> bool:
    return str(getattr(instance, "lifecycle_state", "")).upper() in LIVE_INSTANCE_STATES


def is_live_volume(volume: Any) -> bool:
    return str(getattr(volume, "lifecycle_state", "")).upper() in LIVE_VOLUME_STATES


def a1_usage(instances: Iterable[Any]) -> tuple[float, float]:
    ocpus = 0.0
    memory = 0.0
    for instance in instances:
        if not is_live_instance(instance) or getattr(instance, "shape", None) != SHAPE:
            continue
        shape_config = getattr(instance, "shape_config", None)
        ocpus += float(getattr(shape_config, "ocpus", 0.0) or 0.0)
        memory += float(getattr(shape_config, "memory_in_gbs", 0.0) or 0.0)
    return ocpus, memory


def total_storage_gb(volumes: Iterable[Any]) -> float:
    return sum(
        float(getattr(volume, "size_in_gbs", 0.0) or 0.0)
        for volume in volumes
        if is_live_volume(volume)
    )


def enforce_free_guards(
    *,
    instances: Sequence[Any],
    volumes: Sequence[Any],
    requested_ocpus: float,
    requested_memory_gb: float,
    requested_storage_gb: float,
    limits: GuardLimits,
) -> dict[str, float]:
    used_ocpus, used_memory = a1_usage(instances)
    used_storage = total_storage_gb(volumes)
    if used_ocpus + requested_ocpus > limits.ocpus:
        raise RuntimeError(
            f"A1 OCPU free guard failed: {used_ocpus} used + {requested_ocpus} requested > {limits.ocpus}"
        )
    if used_memory + requested_memory_gb > limits.memory_gb:
        raise RuntimeError(
            f"A1 memory free guard failed: {used_memory} GB used + {requested_memory_gb} GB requested > {limits.memory_gb} GB"
        )
    if used_storage + requested_storage_gb > limits.total_storage_gb:
        raise RuntimeError(
            f"storage free guard failed: {used_storage} GB used + {requested_storage_gb} GB requested > {limits.total_storage_gb} GB"
        )
    return {
        "used_ocpus": used_ocpus,
        "used_memory_gb": used_memory,
        "used_storage_gb": used_storage,
    }


def is_capacity_error(error: BaseException) -> bool:
    status = getattr(error, "status", None)
    code = str(getattr(error, "code", ""))
    message = str(getattr(error, "message", "") or error)
    return CAPACITY_MESSAGE.search(message) is not None and (
        status in {409, 500} or code in {"InternalError", "OutOfHostCapacity"}
    )


def is_throttle_error(error: BaseException) -> bool:
    return getattr(error, "status", None) == 429 or str(getattr(error, "code", "")) == "TooManyRequests"


def is_quota_settling_error(error: BaseException) -> bool:
    """A1 LimitExceeded right after capacity failures, while live usage is zero.

    OCI briefly counts a launch that failed with "Out of host capacity" against
    the A1 core/memory limit.  The preflight free guard has already proven from
    live inventory that the request fits, so this is a pace signal like 429,
    not a reason to fail the round.  A genuinely occupied quota is caught by
    that guard before any launch.
    """
    message = str(getattr(error, "message", "") or error)
    return (
        getattr(error, "status", None) == 400
        and str(getattr(error, "code", "")) == "LimitExceeded"
        and "standard-a1-" in message
    )


def is_pace_error(error: BaseException) -> bool:
    return is_throttle_error(error) or is_quota_settling_error(error)


def retry_token(
    operation: str,
    display_name: str,
    availability_domain: str,
    ocpus: float,
    memory_gb: float,
    day: date | None = None,
) -> str:
    current_day = day or datetime.now(timezone.utc).date()
    return uuid.uuid5(
        uuid.NAMESPACE_URL,
        f"oci-a1:{operation}:{display_name}:{availability_domain}:{ocpus:g}:{memory_gb:g}:{current_day.isoformat()}",
    ).hex


def upgrade_memory_candidates(current_memory_gb: float) -> tuple[float, ...]:
    return tuple(memory_gb for memory_gb in MEMORY_LADDER_GB if memory_gb > current_memory_gb)


def available_memory_candidates(records: Sequence[Any], requested: Sequence[float]) -> tuple[float, ...]:
    available: set[float] = set()
    for record in records:
        if getattr(record, "instance_shape", None) != SHAPE:
            continue
        shape_config = getattr(record, "instance_shape_config", None)
        memory_gb = float(getattr(shape_config, "memory_in_gbs", 0.0) or 0.0)
        availability_status = str(getattr(record, "availability_status", "")).upper()
        available_count = getattr(record, "available_count", None)
        if availability_status == "AVAILABLE" and (available_count is None or int(available_count) > 0):
            available.add(memory_gb)
    return tuple(memory_gb for memory_gb in requested if memory_gb in available)


def capacity_report(
    *,
    oci: Any,
    compute: Any,
    tenancy_id: str,
    availability_domain: str,
    ocpus: float,
    memory_candidates: Sequence[float],
) -> tuple[float, ...]:
    records: list[Any] = []
    for offset in range(0, len(memory_candidates), CAPACITY_REPORT_MAX_SHAPE_CONFIGS):
        batch = memory_candidates[offset : offset + CAPACITY_REPORT_MAX_SHAPE_CONFIGS]
        details = oci.core.models.CreateComputeCapacityReportDetails(
            compartment_id=tenancy_id,
            availability_domain=availability_domain,
            shape_availabilities=[
                oci.core.models.CreateCapacityReportShapeAvailabilityDetails(
                    instance_shape=SHAPE,
                    instance_shape_config=oci.core.models.CapacityReportInstanceShapeConfig(
                        ocpus=ocpus,
                        memory_in_gbs=memory_gb,
                    ),
                )
                for memory_gb in batch
            ],
        )
        response = compute.create_compute_capacity_report(
            details,
            retry_strategy=oci.retry.NoneRetryStrategy(),
        )
        records.extend(response.data.shape_availabilities)
    available = available_memory_candidates(records, memory_candidates)
    emit(
        "capacity_report",
        availability_domain=availability_domain,
        requested_memory_gb=memory_candidates,
        available_memory_gb=available,
    )
    return available


def enforce_resize_free_guards(
    *,
    instances: Sequence[Any],
    volumes: Sequence[Any],
    instance: Any,
    target_ocpus: float,
    target_memory_gb: float,
    limits: GuardLimits,
) -> dict[str, float]:
    used_ocpus, used_memory = a1_usage(instances)
    used_storage = total_storage_gb(volumes)
    current_shape_config = getattr(instance, "shape_config", None)
    current_ocpus = float(getattr(current_shape_config, "ocpus", 0.0) or 0.0)
    current_memory = float(getattr(current_shape_config, "memory_in_gbs", 0.0) or 0.0)
    resulting_ocpus = used_ocpus - current_ocpus + target_ocpus
    resulting_memory = used_memory - current_memory + target_memory_gb
    if resulting_ocpus > limits.ocpus:
        raise RuntimeError(f"A1 resize OCPU free guard failed: resulting {resulting_ocpus} > {limits.ocpus}")
    if resulting_memory > limits.memory_gb:
        raise RuntimeError(
            f"A1 resize memory free guard failed: resulting {resulting_memory} GB > {limits.memory_gb} GB"
        )
    if used_storage > limits.total_storage_gb:
        raise RuntimeError(f"storage free guard failed: {used_storage} GB > {limits.total_storage_gb} GB")
    return {
        "used_ocpus": used_ocpus,
        "used_memory_gb": used_memory,
        "used_storage_gb": used_storage,
        "resulting_ocpus": resulting_ocpus,
        "resulting_memory_gb": resulting_memory,
    }


def choose_image(images: Sequence[Any], pattern: re.Pattern[str]) -> Any:
    matches = [
        image
        for image in images
        if str(getattr(image, "lifecycle_state", "")).upper() == "AVAILABLE"
        and pattern.search(str(getattr(image, "display_name", "")))
    ]
    if not matches:
        raise RuntimeError(f"no AVAILABLE image matched {pattern.pattern!r}")
    return max(matches, key=lambda image: getattr(image, "time_created", datetime.min.replace(tzinfo=timezone.utc)))


def require_single(items: Sequence[Any], label: str) -> Any:
    if len(items) != 1:
        raise RuntimeError(f"expected exactly one {label}, found {len(items)}")
    return items[0]


def write_state(path: Path, **values: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # A successful preflight must not erase launch/resize throttle history.
    # Keep this small and explicit so unrelated state cannot leak forward.
    preserved: dict[str, Any] = {}
    if path.exists():
        try:
            previous = json.loads(path.read_text(encoding="utf-8"))
            preserved = {
                key: previous[key]
                for key in (
                    "throttle_consecutive",
                    "launch_throttle_consecutive",
                    "resize_throttle_consecutive",
                    "preflight_throttle_consecutive",
                    "last_throttle_operation",
                    "last_throttle_at",
                    "launch_spacing_seconds",
                    "resize_spacing_seconds",
                    "launch_non_throttle_streak",
                    "resize_non_throttle_streak",
                )
                if key in previous and key not in values
            }
        except (OSError, json.JSONDecodeError):
            preserved = {}
    temp_path = path.with_suffix(path.suffix + ".tmp")
    temp_path.write_text(
        json.dumps(
            {"updated_at": datetime.now(timezone.utc).isoformat(), **preserved, **values},
            ensure_ascii=False,
            indent=2,
            default=str,
        ),
        encoding="utf-8",
    )
    temp_path.replace(path)


def retry_after_seconds(error: BaseException | None, now: datetime | None = None) -> int | None:
    """Return OCI Retry-After in seconds, accepting both supported HTTP forms."""
    if error is None:
        return None
    headers = getattr(error, "headers", None) or {}
    value = next((v for key, v in headers.items() if str(key).lower() == "retry-after"), None)
    if value is None:
        return None
    text = str(value).strip()
    try:
        numeric = float(text)
        if not math.isfinite(numeric):
            return None
        return max(0, math.ceil(numeric))
    except (ValueError, OverflowError):
        try:
            parsed = email.utils.parsedate_to_datetime(text)
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return max(0, math.ceil((parsed - (now or datetime.now(timezone.utc))).total_seconds()))
        except (TypeError, ValueError, OverflowError):
            return None


def _read_state(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def record_operation_outcome(args: argparse.Namespace, operation: str, *, throttled: bool) -> None:
    """Keep retry pace per mutating operation across scheduler invocations."""
    path = getattr(args, "state_file", None)
    if path is None:
        return
    state = _read_state(path)
    spacing_key = f"{operation}_spacing_seconds"
    current = float(state.get(spacing_key, args.attempt_spacing_seconds))
    floor = float(args.attempt_spacing_seconds)
    if throttled:
        current = min(60.0, max(floor, current * 2.0))
        consecutive_key = f"{operation}_throttle_consecutive"
        state[consecutive_key] = int(state.get(consecutive_key, 0) or 0) + 1
        state["throttle_consecutive"] = state[consecutive_key]
        state[f"{operation}_non_throttle_streak"] = 0
        state["last_throttle_operation"] = operation
        state["last_throttle_at"] = datetime.now(timezone.utc).isoformat()
    else:
        streak_key = f"{operation}_non_throttle_streak"
        streak = int(state.get(streak_key, 0) or 0) + 1
        if streak >= 8:
            current = max(floor, current * 0.8)
            streak = 0
        state[streak_key] = streak
        if state.get("last_throttle_operation") == operation:
            state[f"{operation}_throttle_consecutive"] = 0
            state["throttle_consecutive"] = 0
    state[spacing_key] = current
    write_state(path, **{key: value for key, value in state.items() if key != "updated_at"})


def operation_spacing(args: argparse.Namespace, operation: str) -> float:
    state = _read_state(getattr(args, "state_file", Path(""))) if getattr(args, "state_file", None) else {}
    return max(
        float(args.attempt_spacing_seconds),
        float(state.get(f"{operation}_spacing_seconds", args.attempt_spacing_seconds)),
    )


def wait_after_throttle(
    args: argparse.Namespace, operation: str, error: BaseException | None = None
) -> bool:
    """Persist a real OCI throttle across independent scheduled invocations."""
    previous: dict[str, Any] = {}
    state_file = getattr(args, "state_file", None)
    if state_file is not None and state_file.exists():
        try:
            previous = json.loads(state_file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            previous = {}
    consecutive_key = f"{operation}_throttle_consecutive"
    consecutive = int(previous.get(consecutive_key, 0) or 0) + 1
    spacing_floor = float(getattr(args, "attempt_spacing_seconds", 2.0))
    base = max(DEFAULT_THROTTLE_BACKOFF_SECONDS, int(args.throttle_backoff_seconds))
    adaptive = min(MAX_THROTTLE_BACKOFF_SECONDS, base * (2 ** (consecutive - 1)))
    retry_after = retry_after_seconds(error)
    # Retry-After is authoritative for the first throttle.  On consecutive
    # throttles, the local pace may extend it, never shorten the provider's
    # lower bound.  Avoid jitter on the normal one-minute schedule.
    delay = retry_after if retry_after is not None and consecutive == 1 else max(adaptive, retry_after or 0)
    if retry_after is None and int(args.throttle_backoff_seconds) > DEFAULT_THROTTLE_BACKOFF_SECONDS:
        delay += random.randint(0, args.jitter_seconds)
    values = dict(previous)
    values.pop("updated_at", None)
    values.update(
        throttle_consecutive=consecutive,
        **{consecutive_key: consecutive},
        **{f"{operation}_non_throttle_streak": 0},
        last_throttle_operation=operation,
        last_throttle_at=datetime.now(timezone.utc).isoformat(),
        throttle_delay_seconds=delay,
        **{f"{operation}_spacing_seconds": min(
            60.0,
            max(spacing_floor, float(previous.get(f"{operation}_spacing_seconds", spacing_floor)) * 2.0),
        )},
    )
    if args.once:
        values["operation"] = operation
        values["retry_after"] = (datetime.now(timezone.utc) + timedelta(seconds=delay)).isoformat()
        if state_file is not None:
            write_state(state_file, **values)
        emit("throttle_backoff", operation=operation, seconds=delay, retry_after=values["retry_after"])
        return False
    if state_file is not None:
        write_state(state_file, **values)
    emit("throttle_backoff", operation=operation, seconds=delay)
    time.sleep(delay)
    return True


def active_throttle(path: Path, now: datetime | None = None) -> str | None:
    if not path.exists():
        return None
    state = json.loads(path.read_text(encoding="utf-8"))
    retry_after = state.get("retry_after")
    if state.get("status") == "throttled" and retry_after is not None:
        if datetime.fromisoformat(retry_after) > (now or datetime.now(timezone.utc)):
            return retry_after
    return None


def launch_targets(availability_domains: Sequence[str], resume: dict[str, Any] | None = None) -> list[tuple[float, str]]:
    # Capacity reports are advisory snapshots, not a prerequisite to a launch.
    targets = [(memory, ad) for memory in MEMORY_LADDER_GB for ad in availability_domains]
    if resume and resume.get("status") == "throttled" and resume.get("operation") == "launch":
        previous = (resume.get("memory_gb"), resume.get("availability_domain"))
        if previous in targets:
            return targets[targets.index(previous):]
    return targets


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config-file", type=Path, default=Path.home() / ".oci" / "config")
    parser.add_argument("--profile", default="OMNICODEX_A1")
    parser.add_argument("--compartment-id", help="Target compartment OCID; defaults to the tenancy root")
    parser.add_argument("--subnet-name", required=True)
    parser.add_argument("--display-name", required=True)
    parser.add_argument("--ssh-public-key-file", type=Path, required=True)
    parser.add_argument(
        "--image-pattern",
        default=r"Canonical-Ubuntu-24\.04-Minimal-aarch64",
        help="Case-insensitive regex matched against an AVAILABLE image display name",
    )
    parser.add_argument("--ocpus", type=float, default=2.0)
    parser.add_argument("--boot-volume-gb", type=float, default=50.0)
    parser.add_argument("--max-free-ocpus", type=float, default=2.0)
    parser.add_argument("--max-free-memory-gb", type=float, default=12.0)
    parser.add_argument("--max-free-storage-gb", type=float, default=200.0)
    parser.add_argument("--interval-seconds", type=int, default=300)
    parser.add_argument("--jitter-seconds", type=int, default=30)
    parser.add_argument("--throttle-backoff-seconds", type=int, default=60)
    parser.add_argument("--attempt-spacing-seconds", type=float, default=2.0)
    parser.add_argument("--report-spacing-seconds", type=float, default=10.0)
    parser.add_argument("--once", action="store_true", help="Try each AD once, then exit 75 if all lack capacity")
    parser.add_argument("--dry-run", action="store_true", help="Resolve and validate live resources without launching")
    parser.add_argument(
        "--state-file",
        type=Path,
        default=Path.home() / ".oci" / "omnicodex-a1-capacity-state.json",
    )
    args = parser.parse_args(argv)
    if args.ocpus != 2.0:
        parser.error("this watcher is locked to the current Always Free target: 2 OCPUs")
    if (
        args.boot_volume_gb <= 0
        or args.interval_seconds < 60
        or args.jitter_seconds < 0
        or args.throttle_backoff_seconds < 60
        or args.attempt_spacing_seconds < 0
        or args.report_spacing_seconds < 0
    ):
        parser.error(
            "boot volume must be positive, interval and throttle backoff >= 60 seconds, "
            "and spacing/jitter values >= 0"
        )
    return args


def get_all(oci: Any, call: Any, *args: Any, **kwargs: Any) -> list[Any]:
    return list(oci.pagination.list_call_get_all_results(call, *args, **kwargs).data)


def tenancy_compartments(oci: Any, identity: Any, tenancy_id: str) -> list[str]:
    compartments = get_all(
        oci,
        identity.list_compartments,
        tenancy_id,
        compartment_id_in_subtree=True,
        access_level="ACCESSIBLE",
        lifecycle_state="ACTIVE",
    )
    return [tenancy_id, *(compartment.id for compartment in compartments)]


def live_tenancy_resources(
    oci: Any,
    compute: Any,
    block: Any,
    compartments: Sequence[str],
    availability_domains: Sequence[str],
) -> tuple[list[Any], list[Any]]:
    instances: list[Any] = []
    volumes: list[Any] = []
    for compartment_id in compartments:
        instances.extend(get_all(oci, compute.list_instances, compartment_id))
        volumes.extend(get_all(oci, block.list_volumes, compartment_id=compartment_id))
        for availability_domain in availability_domains:
            volumes.extend(
                get_all(
                    oci,
                    block.list_boot_volumes,
                    compartment_id=compartment_id,
                    availability_domain=availability_domain,
                )
            )
    return instances, volumes


def public_ip_for_instance(oci: Any, compute: Any, network: Any, compartment_id: str, instance_id: str) -> str | None:
    attachments = get_all(
        oci,
        compute.list_vnic_attachments,
        compartment_id,
        instance_id=instance_id,
    )
    if not attachments:
        return None
    return getattr(network.get_vnic(attachments[0].vnic_id).data, "public_ip", None)


def run(argv: Sequence[str]) -> int:
    global EVENT_LOG
    args = parse_args(argv)
    EVENT_LOG = args.state_file.with_suffix(".jsonl")
    retry_after = active_throttle(args.state_file)
    if retry_after is not None:
        emit("scheduled_throttle_wait", retry_after=retry_after)
        return 75
    try:
        import oci  # type: ignore[import-not-found]
    except ImportError:
        emit("fatal", reason="install the official OCI Python SDK: python -m pip install oci")
        return 2

    config = oci.config.from_file(str(args.config_file), args.profile)
    oci.config.validate_config(config)
    tenancy_id = config["tenancy"]
    target_compartment_id = args.compartment_id or tenancy_id
    identity = oci.identity.IdentityClient(config)
    compute = oci.core.ComputeClient(config)
    network = oci.core.VirtualNetworkClient(config)
    block = oci.core.BlockstorageClient(config)

    ads = get_all(oci, identity.list_availability_domains, tenancy_id)
    ad_names = sorted((ad.name for ad in ads), key=lambda name: int(name.rsplit("-", 1)[-1]))
    if not ad_names:
        raise RuntimeError("no availability domains returned")
    compartments = tenancy_compartments(oci, identity, tenancy_id)
    ssh_public_key = args.ssh_public_key_file.read_text(encoding="utf-8").strip()
    if not ssh_public_key.startswith("ssh-"):
        raise RuntimeError("SSH public key must be in OpenSSH authorized_keys format")

    subnet = require_single(
        [
            item
            for item in get_all(
                oci,
                network.list_subnets,
                target_compartment_id,
                display_name=args.subnet_name,
            )
            if str(getattr(item, "lifecycle_state", "")).upper() == "AVAILABLE"
        ],
        f"AVAILABLE subnet named {args.subnet_name!r}",
    )
    images = get_all(
        oci,
        compute.list_images,
        target_compartment_id,
        shape=SHAPE,
        sort_by="TIMECREATED",
        sort_order="DESC",
    )
    image = choose_image(images, re.compile(args.image_pattern, re.IGNORECASE))
    limits = GuardLimits(args.max_free_ocpus, args.max_free_memory_gb, args.max_free_storage_gb)
    free_shape_by_ad: dict[str, Any] = {}
    for availability_domain in ad_names:
        shapes = get_all(
            oci,
            compute.list_shapes,
            target_compartment_id,
            availability_domain=availability_domain,
            image_id=image.id,
        )
        shape = require_single(
            [candidate for candidate in shapes if candidate.shape == SHAPE],
            f"{SHAPE} in {availability_domain}",
        )
        billing_type = str(getattr(shape, "billing_type", "")).upper()
        if billing_type not in ALLOWED_FREE_BILLING_TYPES:
            raise RuntimeError(
                f"refusing non-free billing type {billing_type!r} for {SHAPE} in {availability_domain}"
            )
        free_shape_by_ad[availability_domain] = shape

    while True:
        instances, volumes = live_tenancy_resources(oci, compute, block, compartments, ad_names)
        existing = [
            instance
            for instance in instances
            if is_live_instance(instance) and getattr(instance, "display_name", None) == args.display_name
        ]
        if existing:
            instance = require_single(existing, f"live instance named {args.display_name!r}")
            public_ip = public_ip_for_instance(
                oci, compute, network, instance.compartment_id, instance.id
            )
            shape_config = getattr(instance, "shape_config", None)
            current_ocpus = float(getattr(shape_config, "ocpus", 0.0) or 0.0)
            current_memory_gb = float(getattr(shape_config, "memory_in_gbs", 0.0) or 0.0)
            lifecycle_state = str(getattr(instance, "lifecycle_state", "")).upper()
            if lifecycle_state != "RUNNING":
                write_state(
                    args.state_file,
                    status="existing_transitioning",
                    instance_id=instance.id,
                    availability_domain=instance.availability_domain,
                    lifecycle_state=lifecycle_state,
                    public_ip=public_ip,
                    ocpus=current_ocpus,
                    memory_gb=current_memory_gb,
                )
                emit(
                    "existing_transitioning",
                    instance_id=instance.id,
                    lifecycle_state=lifecycle_state,
                    ocpus=current_ocpus,
                    memory_gb=current_memory_gb,
                )
                return 75
            if current_ocpus != args.ocpus:
                raise RuntimeError(
                    f"existing target instance has unexpected OCPUs: {current_ocpus}; expected {args.ocpus}"
                )
            upgrade_candidates = upgrade_memory_candidates(current_memory_gb)
            if not upgrade_candidates:
                write_state(
                    args.state_file,
                    status="target_reached",
                    instance_id=instance.id,
                    availability_domain=instance.availability_domain,
                    lifecycle_state=lifecycle_state,
                    public_ip=public_ip,
                    ocpus=current_ocpus,
                    memory_gb=current_memory_gb,
                )
                emit("target_reached", instance_id=instance.id, public_ip=public_ip)
                return 0

            available_upgrades = upgrade_candidates

            resize_throttled = False
            for attempt, memory_gb in enumerate(available_upgrades, start=1):
                if attempt > 1:
                    time.sleep(operation_spacing(args, "resize"))
                usage = enforce_resize_free_guards(
                    instances=instances,
                    volumes=volumes,
                    instance=instance,
                    target_ocpus=args.ocpus,
                    target_memory_gb=memory_gb,
                    limits=limits,
                )
                token = retry_token(
                    "resize",
                    args.display_name,
                    instance.availability_domain,
                    args.ocpus,
                    memory_gb,
                )
                emit(
                    "resize_attempt",
                    instance_id=instance.id,
                    availability_domain=instance.availability_domain,
                    current_memory_gb=current_memory_gb,
                    target_memory_gb=memory_gb,
                    retry_token=token,
                    **usage,
                )
                details = oci.core.models.UpdateInstanceDetails(
                    shape=SHAPE,
                    shape_config=oci.core.models.UpdateInstanceShapeConfigDetails(
                        ocpus=args.ocpus,
                        memory_in_gbs=memory_gb,
                    ),
                )
                try:
                    response = compute.update_instance(
                        instance.id,
                        details,
                        opc_retry_token=token,
                        retry_strategy=oci.retry.NoneRetryStrategy(),
                    )
                except oci.exceptions.ServiceError as error:
                    if is_capacity_error(error):
                        record_operation_outcome(args, "resize", throttled=False)
                        emit(
                            "resize_capacity_unavailable",
                            instance_id=instance.id,
                            target_memory_gb=memory_gb,
                            status=error.status,
                            code=error.code,
                            message=error.message,
                        )
                        continue
                    if is_pace_error(error):
                        write_state(
                            args.state_file,
                            status="throttled",
                            operation="resize",
                            instance_id=instance.id,
                            target_memory_gb=memory_gb,
                            attempts=attempt,
                            code=error.code,
                            message=error.message,
                        )
                        emit("throttled", operation="resize", attempts=attempt, code=error.code, message=error.message)
                        if not wait_after_throttle(args, "resize", error):
                            return 75
                        resize_throttled = True
                        break
                    write_state(
                        args.state_file,
                        status="fatal_error",
                        operation="resize",
                        instance_id=instance.id,
                        target_memory_gb=memory_gb,
                        code=error.code,
                        message=error.message,
                    )
                    raise
                updated = response.data
                record_operation_outcome(args, "resize", throttled=False)
                write_state(
                    args.state_file,
                    status="upgrade_requested",
                    instance_id=updated.id,
                    availability_domain=updated.availability_domain,
                    lifecycle_state=updated.lifecycle_state,
                    public_ip=public_ip,
                    previous_memory_gb=current_memory_gb,
                    target_memory_gb=memory_gb,
                    ocpus=args.ocpus,
                )
                emit(
                    "upgrade_requested",
                    instance_id=updated.id,
                    previous_memory_gb=current_memory_gb,
                    target_memory_gb=memory_gb,
                )
                return 75

            if resize_throttled:
                continue

            write_state(
                args.state_file,
                status="waiting_for_upgrade_capacity",
                instance_id=instance.id,
                availability_domain=instance.availability_domain,
                lifecycle_state=lifecycle_state,
                public_ip=public_ip,
                ocpus=current_ocpus,
                memory_gb=current_memory_gb,
                target_candidates_gb=upgrade_candidates,
            )
            emit(
                "waiting_for_upgrade_capacity",
                instance_id=instance.id,
                memory_gb=current_memory_gb,
                target_candidates_gb=upgrade_candidates,
            )
            if args.once:
                return 75
            delay = args.interval_seconds + random.randint(0, args.jitter_seconds)
            emit("sleeping", seconds=delay)
            time.sleep(delay)
            continue

        usage = enforce_free_guards(
            instances=instances,
            volumes=volumes,
            requested_ocpus=args.ocpus,
            requested_memory_gb=MEMORY_LADDER_GB[0],
            requested_storage_gb=args.boot_volume_gb,
            limits=limits,
        )
        record_operation_outcome(args, "preflight", throttled=False)
        emit(
            "preflight_ok",
            shape=SHAPE,
            target_ocpus=args.ocpus,
            target_memory_ladder_gb=MEMORY_LADDER_GB,
            target_boot_volume_gb=args.boot_volume_gb,
            image_id=image.id,
            image_name=image.display_name,
            subnet_id=subnet.id,
            **usage,
        )
        if args.dry_run:
            write_state(args.state_file, status="dry_run_ok", image_id=image.id, subnet_id=subnet.id, **usage)
            return 0

        attempts = 0
        launch_throttled = False
        # Re-read every round: an in-process throttle stores the exact target
        # it stopped at, and the next round must continue from there.
        resume = _read_state(args.state_file)
        for memory_gb, availability_domain in launch_targets(ad_names, resume):
                if attempts:
                    time.sleep(operation_spacing(args, "launch"))
                attempts += 1
                details = oci.core.models.LaunchInstanceDetails(
                    availability_domain=availability_domain,
                    compartment_id=target_compartment_id,
                    display_name=args.display_name,
                    shape=free_shape_by_ad[availability_domain].shape,
                    shape_config=oci.core.models.LaunchInstanceShapeConfigDetails(
                        ocpus=args.ocpus,
                        memory_in_gbs=memory_gb,
                    ),
                    source_details=oci.core.models.InstanceSourceViaImageDetails(
                        image_id=image.id,
                        boot_volume_size_in_gbs=args.boot_volume_gb,
                    ),
                    create_vnic_details=oci.core.models.CreateVnicDetails(
                        subnet_id=subnet.id,
                        assign_public_ip=True,
                    ),
                    metadata={"ssh_authorized_keys": ssh_public_key},
                    freeform_tags={"created-by": "omnicodex-a1-capacity-catcher"},
                )
                token = retry_token(
                    "launch",
                    args.display_name,
                    availability_domain,
                    args.ocpus,
                    memory_gb,
                )
                emit(
                    "launch_attempt",
                    availability_domain=availability_domain,
                    ocpus=args.ocpus,
                    memory_gb=memory_gb,
                    retry_token=token,
                )
                try:
                    response = compute.launch_instance(
                        details,
                        opc_retry_token=token,
                        retry_strategy=oci.retry.NoneRetryStrategy(),
                    )
                except oci.exceptions.ServiceError as error:
                    if is_capacity_error(error):
                        record_operation_outcome(args, "launch", throttled=False)
                        emit(
                            "capacity_unavailable",
                            availability_domain=availability_domain,
                            ocpus=args.ocpus,
                            memory_gb=memory_gb,
                            status=error.status,
                            code=error.code,
                            message=error.message,
                        )
                        continue
                    if is_pace_error(error):
                        write_state(
                            args.state_file,
                            status="throttled",
                            operation="launch",
                            availability_domain=availability_domain,
                            ocpus=args.ocpus,
                            memory_gb=memory_gb,
                            attempts=attempts,
                            code=error.code,
                            message=error.message,
                        )
                        emit(
                            "throttled",
                            availability_domain=availability_domain,
                            attempts=attempts,
                            code=error.code,
                            message=error.message,
                        )
                        if not wait_after_throttle(args, "launch", error):
                            return 75
                        launch_throttled = True
                        break
                    write_state(
                        args.state_file,
                        status="fatal_error",
                        availability_domain=availability_domain,
                        ocpus=args.ocpus,
                        memory_gb=memory_gb,
                        code=error.code,
                        message=error.message,
                    )
                    raise

                instance = response.data
                record_operation_outcome(args, "launch", throttled=False)
                write_state(
                    args.state_file,
                    status="provisioning",
                    instance_id=instance.id,
                    availability_domain=availability_domain,
                    lifecycle_state=instance.lifecycle_state,
                    ocpus=args.ocpus,
                    memory_gb=memory_gb,
                )
                running = oci.wait_until(
                    compute,
                    compute.get_instance(instance.id),
                    "lifecycle_state",
                    "RUNNING",
                    max_wait_seconds=1200,
                    max_interval_seconds=15,
                ).data
                public_ip = public_ip_for_instance(
                    oci, compute, network, target_compartment_id, running.id
                )
                write_state(
                    args.state_file,
                    status="created",
                    instance_id=running.id,
                    availability_domain=availability_domain,
                    lifecycle_state=running.lifecycle_state,
                    public_ip=public_ip,
                    ocpus=args.ocpus,
                    memory_gb=memory_gb,
                )
                emit(
                    "created",
                    instance_id=running.id,
                    availability_domain=availability_domain,
                    public_ip=public_ip,
                    ocpus=args.ocpus,
                    memory_gb=memory_gb,
                )
                return 0 if memory_gb == MEMORY_LADDER_GB[0] else 75

        if launch_throttled:
            continue

        write_state(
            args.state_file,
            status="waiting_for_capacity",
            availability_domains=ad_names,
            ocpus=args.ocpus,
            memory_ladder_gb=MEMORY_LADDER_GB,
            attempts=attempts,
        )
        if args.once:
            return 75
        delay = args.interval_seconds + random.randint(0, args.jitter_seconds)
        emit("sleeping", seconds=delay)
        time.sleep(delay)


def is_retryable_transport_error(error: BaseException) -> bool:
    chain = []
    current = error
    while current is not None and current not in chain:
        chain.append(current)
        current = current.__cause__ or current.__context__
    if any(getattr(item, "status", None) in (408, 429, 500, 502, 503, 504) for item in chain):
        return True
    text = " ".join(str(item).lower() for item in chain)
    if "certificate verify failed" in text or "certificate_verify_failed" in text:
        return False
    names = {type(item).__name__ for item in chain}
    if names & {"Timeout", "TimeoutError", "ConnectTimeout", "ReadTimeout"}:
        return True
    return bool(names & {"RequestException", "ConnectionError", "SSLError", "ProtocolError"}) and any(
        marker in text for marker in (
            "unexpected_eof_while_reading", "eof occurred in violation", "timed out",
            "connection reset", "connection aborted", "remote end closed",
            "temporary failure in name resolution", "connection refused",
        )
    )


def main() -> None:
    try:
        raise SystemExit(run(sys.argv[1:]))
    except KeyboardInterrupt:
        emit("stopped", reason="keyboard_interrupt")
        raise SystemExit(130)
    except Exception as error:
        if is_pace_error(error):
            args = parse_args(sys.argv[1:])
            write_state(args.state_file, status="throttled", operation="preflight",
                        code=getattr(error, "code", None), status_code=getattr(error, "status", None),
                        message=str(error))
            wait_after_throttle(args, "preflight", error)
            raise SystemExit(75)
        retryable = is_retryable_transport_error(error)
        # Record failure before exiting: an old waiting_for_capacity record
        # must not masquerade as a healthy worker. Unknown/permission errors
        # also get a fresh preflight on the next timer tick, never a bypass.
        args = parse_args(sys.argv[1:])
        write_state(args.state_file, status="retryable_error" if retryable else "round_failed",
                    error_type=type(error).__name__, status_code=getattr(error, "status", None),
                    code=getattr(error, "code", None), message=str(error),
                    retry_after_seconds=60)
        emit("round_failed", retryable=retryable, error_type=type(error).__name__, message=str(error))
        raise SystemExit(75 if retryable else 1)


if __name__ == "__main__":
    main()
