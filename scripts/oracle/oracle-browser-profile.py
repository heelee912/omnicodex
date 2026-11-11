#!/usr/bin/env python3
"""Keep Oracle browser tab state disposable while preserving account data."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import tempfile
import time
from urllib.error import URLError
from urllib.parse import quote
from urllib.request import Request, urlopen


def _atomic_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    mode = path.stat().st_mode if path.exists() else 0o600
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(value, stream, ensure_ascii=False, separators=(",", ":"))
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        for attempt in range(20):
            try:
                os.replace(temporary, path)
                return
            except PermissionError:
                if attempt == 19:
                    raise
                time.sleep(min(0.01 * (2**attempt), 0.25))
    finally:
        temporary.unlink(missing_ok=True)


def prepare_start(profile_root: Path) -> None:
    """Discard stale tab journals without deleting cookies or account state."""
    default = profile_root / "Default"
    preferences = default / "Preferences"
    if preferences.exists():
        with preferences.open("r", encoding="utf-8") as stream:
            value = json.load(stream)
        if not isinstance(value, dict):
            raise ValueError("Oracle browser Preferences must contain one JSON object")
        profile = value.setdefault("profile", {})
        if not isinstance(profile, dict):
            raise ValueError("Oracle browser profile preferences are malformed")
        profile["exit_type"] = "Normal"
        profile["exited_cleanly"] = True
        _atomic_json(preferences, value)

    sessions = default / "Sessions"
    if sessions.exists():
        shutil.rmtree(sessions)
    for legacy_name in ("Current Session", "Current Tabs", "Last Session", "Last Tabs"):
        (default / legacy_name).unlink(missing_ok=True)
    for singleton_name in ("SingletonCookie", "SingletonLock", "SingletonSocket"):
        (profile_root / singleton_name).unlink(missing_ok=True)


def _json(endpoint: str, path: str, method: str = "GET") -> object:
    request = Request(f"{endpoint.rstrip('/')}{path}", method=method)
    with urlopen(request, timeout=2.0) as response:
        return json.loads(response.read().decode("utf-8"))


def close_targets(endpoint: str) -> None:
    """Best-effort close page targets before the owned browser is stopped."""
    try:
        targets = _json(endpoint, "/json/list")
        if not isinstance(targets, list):
            return
        for target in targets:
            if not isinstance(target, dict) or target.get("type") != "page":
                continue
            target_id = target.get("id")
            if not isinstance(target_id, str) or not target_id:
                continue
            try:
                _json(endpoint, f"/json/close/{quote(target_id, safe='')}", "PUT")
            except (OSError, URLError, TimeoutError, ValueError, json.JSONDecodeError):
                continue

        deadline = time.monotonic() + 8.0
        while time.monotonic() < deadline:
            remaining = _json(endpoint, "/json/list")
            if not isinstance(remaining, list):
                return
            if not any(
                isinstance(target, dict) and target.get("type") == "page"
                for target in remaining
            ):
                return
            time.sleep(0.1)
    except (OSError, URLError, TimeoutError, ValueError, json.JSONDecodeError):
        return


def main() -> int:
    parser = argparse.ArgumentParser()
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--prepare-start", type=Path)
    action.add_argument("--close-targets")
    arguments = parser.parse_args()
    if arguments.prepare_start is not None:
        prepare_start(arguments.prepare_start.resolve())
    else:
        close_targets(str(arguments.close_targets))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
