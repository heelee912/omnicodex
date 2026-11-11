"""Install the official Caddy release with safe request-body reconnect handling."""

import hashlib
import io
import os
import pathlib
import platform
import subprocess
import tarfile
import tempfile
import urllib.request

VERSION = "2.11.4"
ROOT = pathlib.Path("/opt/omnicodex-ingress")
MANAGED = ROOT / ("caddy-" + VERSION)
DROPIN = pathlib.Path("/etc/systemd/system/caddy.service.d/omnicodex-reconnect.conf")


def install():
    if os.geteuid() != 0:
        raise RuntimeError("Run the ingress installer as root")
    existing_version = (
        subprocess.check_output([str(MANAGED), "version"], text=True).strip()
        if MANAGED.is_file()
        else ""
    )
    if not existing_version.startswith("v" + VERSION + " "):
        arch = {"x86_64": "amd64", "aarch64": "arm64"}[platform.machine()]
        asset = f"caddy_{VERSION}_linux_{arch}.tar.gz"
        base = f"https://github.com/caddyserver/caddy/releases/download/v{VERSION}/"
        with urllib.request.urlopen(base + f"caddy_{VERSION}_checksums.txt", timeout=30) as response:
            checksums = response.read().decode()
        expected = next(line.split()[0] for line in checksums.splitlines() if line.split()[-1] == asset)
        with urllib.request.urlopen(base + asset, timeout=30) as response:
            archive = response.read()
        if len(expected) != 128 or hashlib.sha512(archive).hexdigest() != expected:
            raise RuntimeError("Official Caddy SHA-512 checksum mismatch")
        ROOT.mkdir(parents=True, exist_ok=True)
        with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tar:
            source = tar.extractfile("caddy")
            if source is None:
                raise RuntimeError("Official archive does not contain Caddy")
            with tempfile.NamedTemporaryFile(dir=ROOT, delete=False) as target:
                candidate = pathlib.Path(target.name)
                target.write(source.read())
        try:
            candidate.chmod(0o755)
            version = subprocess.check_output([str(candidate), "version"], text=True)
            if not version.startswith("v" + VERSION + " "):
                raise RuntimeError("Official Caddy binary version differs")
            candidate.replace(MANAGED)
        finally:
            candidate.unlink(missing_ok=True)

    subprocess.run(
        [str(MANAGED), "validate", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"],
        check=True, stdout=subprocess.DEVNULL,
    )
    desired = (
        "[Service]\nExecStart=\nExecStart=" + str(MANAGED)
        + " run --environ --config /etc/caddy/Caddyfile\nExecReload=\nExecReload="
        + str(MANAGED) + " reload --config /etc/caddy/Caddyfile --force\n"
    )
    previous = DROPIN.read_text() if DROPIN.exists() else None
    pid = subprocess.check_output(["systemctl", "show", "caddy", "-p", "MainPID", "--value"], text=True).strip()
    running = pathlib.Path("/proc/" + pid + "/exe").resolve()
    if previous == desired and running == MANAGED:
        return str(MANAGED)
    DROPIN.parent.mkdir(parents=True, exist_ok=True)
    DROPIN.write_text(desired)
    try:
        subprocess.run(["systemctl", "daemon-reload"], check=True, timeout=15)
        subprocess.run(["systemctl", "try-restart", "caddy"], check=True, timeout=30)
    except Exception:
        if previous is None:
            DROPIN.unlink()
        else:
            DROPIN.write_text(previous)
        subprocess.run(["systemctl", "daemon-reload"], timeout=15)
        subprocess.run(["systemctl", "try-restart", "caddy"], timeout=30)
        raise
    return str(MANAGED)


if __name__ == "__main__":
    print(install())
