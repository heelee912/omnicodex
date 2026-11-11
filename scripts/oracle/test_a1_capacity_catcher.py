from __future__ import annotations

import importlib.util
import json
import sys
import unittest
import tempfile
from dataclasses import dataclass
from datetime import date, datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch


MODULE_PATH = Path(__file__).with_name("a1_capacity_catcher.py")
SPEC = importlib.util.spec_from_file_location("a1_capacity_catcher", MODULE_PATH)
assert SPEC and SPEC.loader
catcher = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = catcher
SPEC.loader.exec_module(catcher)


@dataclass
class ShapeConfig:
    ocpus: float
    memory_in_gbs: float


@dataclass
class Instance:
    shape: str
    lifecycle_state: str
    shape_config: ShapeConfig


@dataclass
class Volume:
    size_in_gbs: float
    lifecycle_state: str


@dataclass
class Image:
    display_name: str
    lifecycle_state: str
    time_created: datetime


@dataclass
class CapacityRecord:
    instance_shape: str
    instance_shape_config: ShapeConfig
    availability_status: str
    available_count: int | None = None


class ServiceError(Exception):
    def __init__(self, status: int, code: str, message: str, headers=None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.headers = headers or {}


class CapacityCatcherTest(unittest.TestCase):
    def test_preflight_503_retries_and_replaces_stale_waiting_status(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.json"
            path.write_text('{"status":"waiting_for_capacity"}')
            args = SimpleNamespace(state_file=path)
            with patch.object(catcher, "run", side_effect=ServiceError(503, "ServiceUnavailable", "down")), patch.object(catcher, "parse_args", return_value=args):
                with self.assertRaises(SystemExit) as result:
                    catcher.main()
            self.assertEqual(result.exception.code, 75)
            self.assertEqual(json.loads(path.read_text())["status"], "retryable_error")

    def test_wrapper_cannot_latch_a_failed_round_forever(self) -> None:
        wrapper = MODULE_PATH.with_name("a1-capacity-run.sh").read_text()
        self.assertNotIn("printf 'fatal:", wrapper)
        self.assertIn("printf 'completed", wrapper)

    def test_retry_classification_keeps_permission_and_certificate_errors_distinct(self) -> None:
        self.assertFalse(catcher.is_retryable_transport_error(ServiceError(403, "Forbidden", "denied")))
        self.assertTrue(catcher.is_retryable_transport_error(TimeoutError("timed out")))
        self.assertFalse(catcher.is_retryable_transport_error(Exception("certificate verify failed")))

    def test_one_scheduled_round_launches_every_ad_and_memory_without_report_gate(self) -> None:
        sdk = MagicMock()
        sdk.exceptions.ServiceError = ServiceError
        compute = sdk.core.ComputeClient.return_value
        compute.launch_instance.side_effect = ServiceError(500, "InternalError", "Out of host capacity")
        ads = [SimpleNamespace(name=f"region-AD-{index}") for index in (1, 2, 3)]
        def get_all(_oci, call, *args, **kwargs):
            if call == sdk.identity.IdentityClient.return_value.list_availability_domains:
                return ads
            if call == sdk.core.VirtualNetworkClient.return_value.list_subnets:
                return [SimpleNamespace(id="subnet", lifecycle_state="AVAILABLE")]
            if call == compute.list_shapes:
                return [SimpleNamespace(shape=catcher.SHAPE, billing_type="ALWAYS_FREE")]
            return []
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            key = root / "key.pub"
            key.write_text("ssh-ed25519 test")
            with patch.dict(sys.modules, {"oci": sdk}), patch.object(catcher, "get_all", side_effect=get_all), \
                 patch.object(catcher, "tenancy_compartments", return_value=["tenancy"]), \
                 patch.object(catcher, "live_tenancy_resources", return_value=([], [])), \
                 patch.object(catcher, "choose_image", return_value=SimpleNamespace(id="image", display_name="Ubuntu")), \
                 patch.object(catcher, "emit"):
                result = catcher.run(["--subnet-name", "subnet", "--display-name", "target",
                    "--ssh-public-key-file", str(key), "--state-file", str(root / "state.json"),
                    "--attempt-spacing-seconds", "0", "--once"])
            self.assertEqual(result, 75)
            self.assertEqual(compute.launch_instance.call_count, 33)
            compute.create_compute_capacity_report.assert_not_called()
            details = sdk.core.models.LaunchInstanceDetails.call_args_list
            self.assertEqual([call.kwargs["availability_domain"] for call in details[:3]],
                             [ad.name for ad in ads])
            self.assertTrue(all("fault_domain" not in call.kwargs for call in details))
        catcher.EVENT_LOG = None

    def test_once_throttle_is_durable_and_expires_without_changing_schedule(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.json"
            catcher.write_state(path, status="throttled", code="TooManyRequests", message="exact error")
            args = SimpleNamespace(once=True, state_file=path, throttle_backoff_seconds=300, jitter_seconds=0)
            with patch.object(catcher, "emit"), patch.object(catcher.time, "sleep") as sleep:
                self.assertFalse(catcher.wait_after_throttle(args, "launch"))
                self.assertIsNotNone(catcher.active_throttle(path))
                self.assertIsNone(catcher.active_throttle(path, datetime(2099, 1, 1, tzinfo=timezone.utc)))
                sleep.assert_not_called()
            self.assertIn("exact error", path.read_text())

    def test_throttle_resume_reaches_lower_memory_instead_of_restarting_at_twelve(self) -> None:
        ads = ["AD-1", "AD-2", "AD-3"]
        remaining = catcher.launch_targets(ads, {"status": "throttled", "operation": "launch",
                                                 "memory_gb": 7, "availability_domain": "AD-1"})
        self.assertEqual(remaining[0], (7.0, "AD-1"))
        self.assertEqual(remaining[-1], (2.0, "AD-3"))
        self.assertEqual(len(remaining), 18)

    def test_free_guard_counts_all_live_a1_and_storage(self) -> None:
        result = catcher.enforce_free_guards(
            instances=[Instance(catcher.SHAPE, "RUNNING", ShapeConfig(1, 6))],
            volumes=[Volume(50, "AVAILABLE"), Volume(50, "TERMINATED")],
            requested_ocpus=1,
            requested_memory_gb=6,
            requested_storage_gb=50,
            limits=catcher.GuardLimits(),
        )
        self.assertEqual(result, {"used_ocpus": 1.0, "used_memory_gb": 6.0, "used_storage_gb": 50.0})

    def test_free_guard_rejects_resource_overage(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "OCPU free guard failed"):
            catcher.enforce_free_guards(
                instances=[Instance(catcher.SHAPE, "RUNNING", ShapeConfig(1, 6))],
                volumes=[],
                requested_ocpus=2,
                requested_memory_gb=6,
                requested_storage_gb=50,
                limits=catcher.GuardLimits(),
            )

    def test_only_exact_capacity_failure_is_retryable(self) -> None:
        self.assertTrue(
            catcher.is_capacity_error(
                ServiceError(500, "InternalError", "Out of capacity for shape VM.Standard.A1.Flex")
            )
        )
        self.assertFalse(catcher.is_capacity_error(ServiceError(429, "TooManyRequests", "rate limited")))
        self.assertFalse(catcher.is_capacity_error(ServiceError(403, "NotAuthorized", "not authorized")))

    def test_throttle_is_backed_off_but_not_treated_as_capacity(self) -> None:
        error = ServiceError(429, "TooManyRequests", "User-rate limit exceeded")
        self.assertTrue(catcher.is_throttle_error(error))
        self.assertFalse(catcher.is_capacity_error(error))

    def test_throttle_backoff_keeps_warm_watcher_alive(self) -> None:
        args = SimpleNamespace(once=False, throttle_backoff_seconds=300, jitter_seconds=10)
        with patch.object(catcher.random, "randint", return_value=7), patch.object(
            catcher.time, "sleep"
        ) as sleep:
            self.assertTrue(catcher.wait_after_throttle(args, "capacity_report_launch"))
        sleep.assert_called_once_with(307)

    def test_retry_after_header_seconds_is_honored(self) -> None:
        error = ServiceError(429, "TooManyRequests", "rate limited", {"Retry-After": "17"})
        self.assertEqual(catcher.retry_after_seconds(error), 17)

    def test_retry_after_http_date_is_honored(self) -> None:
        error = ServiceError(429, "TooManyRequests", "rate limited", {"retry-after": "Wed, 10 Sep 2026 00:01:30 GMT"})
        now = datetime(2026, 9, 10, 0, 1, 0, tzinfo=timezone.utc)
        self.assertEqual(catcher.retry_after_seconds(error, now), 30)

    def test_throttle_adapts_and_preserves_history_across_preflight(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.json"
            catcher.write_state(path, status="throttled", operation="launch")
            args = SimpleNamespace(once=True, state_file=path, throttle_backoff_seconds=60, jitter_seconds=0)
            error = ServiceError(429, "TooManyRequests", "rate limited")
            with patch.object(catcher, "emit"):
                self.assertFalse(catcher.wait_after_throttle(args, "launch", error))
            state = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(state["throttle_delay_seconds"], 60)
            self.assertEqual(state["throttle_consecutive"], 1)
            catcher.write_state(path, status="preflight_ok")
            state = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(state["throttle_consecutive"], 1)
            self.assertEqual(state["last_throttle_operation"], "launch")

    def test_capacity_outcome_resets_only_same_operation_throttle_pace(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.json"
            args = SimpleNamespace(state_file=path, attempt_spacing_seconds=2.0)
            with patch.object(catcher, "emit"):
                catcher.record_operation_outcome(args, "launch", throttled=True)
            state = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(state["throttle_consecutive"], 1)
            self.assertEqual(state["launch_spacing_seconds"], 4.0)
            catcher.record_operation_outcome(args, "launch", throttled=False)
            state = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(state["throttle_consecutive"], 0)
            self.assertEqual(state["launch_spacing_seconds"], 4.0)
            catcher.record_operation_outcome(args, "launch", throttled=False)
            state = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(state["launch_spacing_seconds"], 4.0)
            self.assertEqual(state["launch_non_throttle_streak"], 2)
            for _ in range(6):
                catcher.record_operation_outcome(args, "launch", throttled=False)
            state = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(state["launch_spacing_seconds"], 3.2)
            self.assertEqual(state["launch_non_throttle_streak"], 0)
            with patch.object(catcher, "emit"):
                catcher.wait_after_throttle(
                    SimpleNamespace(once=True, state_file=path, throttle_backoff_seconds=60, jitter_seconds=0),
                    "launch",
                    ServiceError(429, "TooManyRequests", "rate limited"),
                )
            state = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(state["throttle_consecutive"], 1)
            self.assertEqual(state["throttle_delay_seconds"], 60)

    def test_consecutive_throttles_increase_operation_spacing(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.json"
            args = SimpleNamespace(state_file=path, attempt_spacing_seconds=2.0)
            catcher.record_operation_outcome(args, "launch", throttled=True)
            catcher.record_operation_outcome(args, "launch", throttled=True)
            state = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(state["throttle_consecutive"], 2)
            self.assertEqual(state["launch_spacing_seconds"], 8.0)

    def test_throttle_counters_are_independent_per_operation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.json"
            args = SimpleNamespace(state_file=path, attempt_spacing_seconds=2.0)
            catcher.record_operation_outcome(args, "preflight", throttled=True)
            catcher.record_operation_outcome(args, "preflight", throttled=False)
            catcher.record_operation_outcome(args, "launch", throttled=True)
            state = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(state["preflight_throttle_consecutive"], 0)
            self.assertEqual(state["launch_throttle_consecutive"], 1)
            self.assertEqual(state["throttle_consecutive"], 1)

    def test_scheduler_restart_preserves_adaptive_attempt_spacing(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.json"
            args = SimpleNamespace(state_file=path, attempt_spacing_seconds=2.0)
            catcher.record_operation_outcome(args, "resize", throttled=True)
            restarted = SimpleNamespace(state_file=path, attempt_spacing_seconds=2.0)
            self.assertEqual(catcher.operation_spacing(restarted, "resize"), 4.0)

    def test_invalid_retry_after_values_are_ignored(self) -> None:
        for value in ("NaN", "Infinity", "not-a-date"):
            self.assertIsNone(
                catcher.retry_after_seconds(ServiceError(429, "TooManyRequests", "rate limited", {"Retry-After": value}))
            )

    def test_retry_token_is_stable_per_name_ad_shape_and_day(self) -> None:
        first = catcher.retry_token("launch", "omnicodex-a1", "qVeu:PHX-AD-1", 2, 12, date(2026, 9, 4))
        second = catcher.retry_token("launch", "omnicodex-a1", "qVeu:PHX-AD-1", 2, 12, date(2026, 9, 4))
        other_ad = catcher.retry_token("launch", "omnicodex-a1", "qVeu:PHX-AD-2", 2, 12, date(2026, 9, 4))
        lower_memory = catcher.retry_token("launch", "omnicodex-a1", "qVeu:PHX-AD-1", 2, 11, date(2026, 9, 4))
        resize = catcher.retry_token("resize", "omnicodex-a1", "qVeu:PHX-AD-1", 2, 12, date(2026, 9, 4))
        self.assertEqual(first, second)
        self.assertNotEqual(first, other_ad)
        self.assertNotEqual(first, lower_memory)
        self.assertNotEqual(first, resize)
        self.assertEqual(len(first), 32)

    def test_memory_ladder_preserves_ocpus_and_descends_one_gb_at_a_time(self) -> None:
        self.assertEqual(
            catcher.MEMORY_LADDER_GB,
            (12.0, 11.0, 10.0, 9.0, 8.0, 7.0, 6.0, 5.0, 4.0, 3.0, 2.0),
        )
        self.assertEqual(catcher.upgrade_memory_candidates(2), (12.0, 11.0, 10.0, 9.0, 8.0, 7.0, 6.0, 5.0, 4.0, 3.0))
        self.assertEqual(catcher.upgrade_memory_candidates(9), (12.0, 11.0, 10.0))
        self.assertEqual(catcher.upgrade_memory_candidates(12), ())

    def test_capacity_report_preserves_requested_priority(self) -> None:
        records = [
            CapacityRecord(catcher.SHAPE, ShapeConfig(2, 9), "AVAILABLE", 1),
            CapacityRecord(catcher.SHAPE, ShapeConfig(2, 12), "UNAVAILABLE", 0),
            CapacityRecord(catcher.SHAPE, ShapeConfig(2, 7), "AVAILABLE", 1),
            CapacityRecord(catcher.SHAPE, ShapeConfig(2, 2), "AVAILABLE", 1),
        ]
        self.assertEqual(
            catcher.available_memory_candidates(records, catcher.MEMORY_LADDER_GB),
            (9.0, 7.0, 2.0),
        )

    def test_capacity_report_batches_full_ladder_without_dropping_two_gb(self) -> None:
        class Models:
            @staticmethod
            def CapacityReportInstanceShapeConfig(**values):
                return SimpleNamespace(**values)

            @staticmethod
            def CreateCapacityReportShapeAvailabilityDetails(**values):
                return SimpleNamespace(**values)

            @staticmethod
            def CreateComputeCapacityReportDetails(**values):
                return SimpleNamespace(**values)

        class Compute:
            def __init__(self) -> None:
                self.requests = []

            def create_compute_capacity_report(self, details, retry_strategy):
                self.requests.append(details)
                records = [
                    CapacityRecord(
                        catcher.SHAPE,
                        ShapeConfig(config.instance_shape_config.ocpus, config.instance_shape_config.memory_in_gbs),
                        "AVAILABLE" if config.instance_shape_config.memory_in_gbs == 2 else "UNAVAILABLE",
                        1 if config.instance_shape_config.memory_in_gbs == 2 else 0,
                    )
                    for config in details.shape_availabilities
                ]
                return SimpleNamespace(data=SimpleNamespace(shape_availabilities=records))

        compute = Compute()
        oci = SimpleNamespace(
            core=SimpleNamespace(models=Models),
            retry=SimpleNamespace(NoneRetryStrategy=lambda: object()),
        )
        available = catcher.capacity_report(
            oci=oci,
            compute=compute,
            tenancy_id="tenancy",
            availability_domain="qVeu:PHX-AD-1",
            ocpus=2,
            memory_candidates=catcher.MEMORY_LADDER_GB,
        )
        self.assertEqual([len(request.shape_availabilities) for request in compute.requests], [10, 1])
        self.assertEqual(
            [
                config.instance_shape_config.memory_in_gbs
                for request in compute.requests
                for config in request.shape_availabilities
            ],
            list(catcher.MEMORY_LADDER_GB),
        )
        self.assertEqual(available, (2.0,))

    def test_capacity_report_rejects_zero_count_or_other_shape(self) -> None:
        records = [
            CapacityRecord(catcher.SHAPE, ShapeConfig(2, 12), "AVAILABLE", 0),
            CapacityRecord("VM.Standard.E4.Flex", ShapeConfig(2, 11), "AVAILABLE", 1),
        ]
        self.assertEqual(catcher.available_memory_candidates(records, catcher.MEMORY_LADDER_GB), ())

    def test_resize_guard_replaces_existing_shape_instead_of_double_counting(self) -> None:
        instance = Instance(catcher.SHAPE, "RUNNING", ShapeConfig(2, 7))
        result = catcher.enforce_resize_free_guards(
            instances=[instance],
            volumes=[Volume(97, "AVAILABLE")],
            instance=instance,
            target_ocpus=2,
            target_memory_gb=12,
            limits=catcher.GuardLimits(),
        )
        self.assertEqual(result["resulting_ocpus"], 2)
        self.assertEqual(result["resulting_memory_gb"], 12)

    def test_a1_limit_exceeded_is_a_pace_signal_not_a_failed_round(self) -> None:
        settling = ServiceError(
            400, "LimitExceeded",
            "The following service limits were exceeded: standard-a1-memory-regional-count, standard-a1-core-regional-count.",
        )
        self.assertTrue(catcher.is_quota_settling_error(settling))
        self.assertTrue(catcher.is_pace_error(settling))
        self.assertFalse(catcher.is_quota_settling_error(ServiceError(400, "LimitExceeded", "vcn-count")))
        self.assertFalse(catcher.is_quota_settling_error(ServiceError(400, "InvalidParameter", "standard-a1-core-count")))

    def test_in_process_throttle_resumes_at_the_stopped_target(self) -> None:
        sdk = MagicMock()
        sdk.exceptions.ServiceError = ServiceError
        compute = sdk.core.ComputeClient.return_value
        settling = ServiceError(400, "LimitExceeded", "exceeded: standard-a1-core-regional-count")
        capacity = ServiceError(500, "InternalError", "Out of host capacity")
        # Round 1: two capacity misses, then quota settling at the third target.
        # Round 2 must start at that third target, not back at 12 GB / AD-1.
        compute.launch_instance.side_effect = [capacity, capacity, settling] + [capacity] * 40
        ads = [SimpleNamespace(name=f"region-AD-{index}") for index in (1, 2, 3)]
        def get_all(_oci, call, *args, **kwargs):
            if call == sdk.identity.IdentityClient.return_value.list_availability_domains:
                return ads
            if call == sdk.core.VirtualNetworkClient.return_value.list_subnets:
                return [SimpleNamespace(id="subnet", lifecycle_state="AVAILABLE")]
            if call == compute.list_shapes:
                return [SimpleNamespace(shape=catcher.SHAPE, billing_type="ALWAYS_FREE")]
            return []
        rounds = {"sleeps": 0}
        def fake_sleep(seconds):
            rounds["sleeps"] += 1
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            key = root / "key.pub"
            key.write_text("ssh-ed25519 test")
            with patch.dict(sys.modules, {"oci": sdk}), patch.object(catcher, "get_all", side_effect=get_all),                  patch.object(catcher, "tenancy_compartments", return_value=["tenancy"]),                  patch.object(catcher, "live_tenancy_resources", return_value=([], [])),                  patch.object(catcher, "choose_image", return_value=SimpleNamespace(id="image", display_name="Ubuntu")),                  patch.object(catcher, "emit"), patch.object(catcher.time, "sleep", side_effect=fake_sleep),                  patch.object(catcher, "launch_targets", wraps=catcher.launch_targets) as targets:
                with self.assertRaises(StopIteration):
                    catcher.run(["--subnet-name", "subnet", "--display-name", "target",
                        "--ssh-public-key-file", str(key), "--state-file", str(root / "state.json"),
                        "--attempt-spacing-seconds", "0"])
            second_round = catcher.launch_targets(*targets.call_args_list[1].args)
            self.assertEqual(second_round[0], (12.0, "region-AD-3"))
        catcher.EVENT_LOG = None

    def test_event_log_rotates_instead_of_growing_forever(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / "state.jsonl"
            log.write_bytes(b"x" * (catcher.EVENT_LOG_MAX_BYTES + 1))
            catcher.EVENT_LOG = log
            try:
                catcher.emit("probe")
            finally:
                catcher.EVENT_LOG = None
            self.assertTrue(log.with_name("state.jsonl.1").exists())
            self.assertLess(log.stat().st_size, 1024)

    def test_choose_image_uses_latest_available_match(self) -> None:
        images = [
            Image("Canonical-Ubuntu-24.04-Minimal-aarch64-old", "AVAILABLE", datetime(2026, 8, 1, tzinfo=timezone.utc)),
            Image("Canonical-Ubuntu-24.04-Minimal-aarch64-new", "AVAILABLE", datetime(2026, 9, 1, tzinfo=timezone.utc)),
            Image("Canonical-Ubuntu-24.04-Minimal-aarch64-newer", "DELETED", datetime(2026, 9, 2, tzinfo=timezone.utc)),
        ]
        chosen = catcher.choose_image(images, __import__("re").compile("Minimal-aarch64"))
        self.assertEqual(chosen.display_name, "Canonical-Ubuntu-24.04-Minimal-aarch64-new")


if __name__ == "__main__":
    unittest.main()
