"""Exercise the production launcher without starting or signing into a browser."""

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


class OracleBrowserLaunchTest(unittest.TestCase):
    def test_fresh_start_provides_one_native_event_renderer(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            browser = root / "browser"
            browser.write_text('#!/bin/sh\nprintf "%s\\n" "$@"\n', encoding="utf-8")
            browser.chmod(0o700)
            profile = root / "isolated profile"
            result = subprocess.run(
                ["bash", str(Path(__file__).with_name("oracle-browser-run.sh"))],
                env={
                    **os.environ,
                    "ORACLE_BROWSER_EXECUTABLE": str(browser),
                    "ORACLE_BROWSER_PROFILE": str(profile),
                },
                text=True,
                capture_output=True,
                check=True,
            )
            arguments = result.stdout.splitlines()
            self.assertEqual(arguments.count("https://chatgpt.com/"), 1)
            self.assertNotIn("--no-startup-window", arguments)
            self.assertIn(f"--user-data-dir={profile}", arguments)
            self.assertIn("--remote-debugging-address=127.0.0.1", arguments)
            self.assertIn("--remote-debugging-port=19222", arguments)
            self.assertEqual(result.stderr, "")

    def test_separate_instance_uses_only_its_explicit_profile_and_port(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            browser = root / "browser"
            browser.write_text('#!/bin/sh\nprintf "%s\\n" "$@"\n', encoding="utf-8")
            browser.chmod(0o700)
            profile = root / "second profile"
            env = {**os.environ, "ORACLE_BROWSER_EXECUTABLE": str(browser),
                   "ORACLE_BROWSER_PROFILE": str(profile), "ORACLE_BROWSER_CDP_PORT": "19223"}
            result = subprocess.run(["bash", str(Path(__file__).with_name("oracle-browser-run.sh"))],
                                    env=env, text=True, capture_output=True, check=True)
            arguments = result.stdout.splitlines()
            self.assertIn("--remote-debugging-port=19223", arguments)
            self.assertNotIn("--remote-debugging-port=19222", arguments)
            self.assertIn(f"--user-data-dir={profile}", arguments)
            self.assertEqual(arguments.count("https://chatgpt.com/"), 1)
            for invalid in ("0", "65536", "-1", "19223 --other-flag"):
                with self.subTest(port=invalid):
                    failed = subprocess.run(
                        ["bash", str(Path(__file__).with_name("oracle-browser-run.sh"))],
                        env={**env, "ORACLE_BROWSER_CDP_PORT": invalid},
                        text=True, capture_output=True)
                    self.assertEqual(failed.returncode, 64)
                    self.assertEqual(failed.stdout, "")

    def test_installer_keeps_primary_configuration_and_installs_an_isolated_named_service(self):
        # All absolute installation paths are redirected into this temporary
        # tree; ownership and service commands are stubs, not host mutations.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            scripts = root / "scripts"
            scripts.mkdir()
            source = Path(__file__).parent
            for name in ("oracle-browser-run.sh", "oracle-browser-profile.py",
                         "omnicodex-oracle-browser.service", "omnicodex-oracle-browser@.service",
                         "omnicodex-oracle-xvfb.service", "omnicodex-oracle-xvfb@.service"):
                shutil.copyfile(source / name, scripts / name)
            installer = scripts / "install-oracle-browser-host.sh"
            installer.write_text(
                (source / installer.name).read_text(encoding="utf-8")
                .replace("/etc/", f"{root}/etc/")
                .replace("/opt/", f"{root}/opt/")
                .replace("/home/ubuntu", f"{root}/home/ubuntu"), encoding="utf-8")
            (root / "etc/systemd/system").mkdir(parents=True)
            tools = root / "bin"
            tools.mkdir()
            service_log = root / "services.log"
            stubs = {
                "id": '#!/bin/sh\nif [ "$1" = -u ]; then echo 0; fi\n',
                "Xvfb": "#!/bin/sh\nexit 0\n",
                "x11vnc": "#!/bin/sh\nexit 0\n",
                "systemctl": f'#!/bin/sh\nprintf "%s\\n" "$*" >> "{service_log}"\n',
                "install": '''#!/usr/bin/env python3
import subprocess, sys
args = iter(sys.argv[1:])
kept = []
for arg in args:
    if arg in ("-o", "-g"):
        next(args)
    else:
        kept.append(arg)
subprocess.run(["/usr/bin/install", *kept], check=True)
''',
                "browser": '#!/bin/sh\necho "Test Chromium"\n',
            }
            for name, content in stubs.items():
                path = tools / name
                path.write_text(content, encoding="utf-8")
                path.chmod(0o700)
            env = {**os.environ, "PATH": f"{tools}:{os.environ['PATH']}"}
            command = ["bash", str(installer), str(tools / "browser")]
            subprocess.run(command, env=env, text=True, capture_output=True, check=True)
            primary_files = [root / "etc/omnicodex-oracle-browser.env",
                             root / "etc/systemd/system/omnicodex-oracle-browser.service",
                             root / "etc/systemd/system/omnicodex-oracle-xvfb.service"]
            original = {path: path.read_bytes() for path in primary_files}
            service_log.write_text("", encoding="utf-8")
            profile = root / "home/ubuntu/omnicodex-lab/home/.oracle/second-profile"
            result = subprocess.run(command + ["second", str(profile), "19223", "178"], env=env,
                                    text=True, capture_output=True, check=True)
            for path, contents in original.items():
                self.assertEqual(path.read_bytes(), contents)
            self.assertIn("service=omnicodex-oracle-browser@second.service", result.stdout)
            second_env = (root / "etc/omnicodex-oracle-browser-second.env").read_text()
            self.assertIn(f"ORACLE_BROWSER_PROFILE={profile}\n", second_env)
            self.assertIn("ORACLE_BROWSER_CDP_PORT=19223\n", second_env)
            self.assertIn("DISPLAY=:178\n", second_env)
            self.assertIn("display_requested=:178 restart_required=false", result.stdout)
            self.assertNotIn(" omnicodex-oracle-browser.service", service_log.read_text())
            self.assertNotIn(" omnicodex-oracle-xvfb.service", service_log.read_text())
            self.assertIn("omnicodex-oracle-browser@second.service", service_log.read_text())
            self.assertIn("omnicodex-oracle-xvfb@second.service", service_log.read_text())
            template = (root / "etc/systemd/system/omnicodex-oracle-browser@.service").read_text()
            self.assertIn("EnvironmentFile=/etc/omnicodex-oracle-browser-%i.env", template)
            self.assertIn("http://127.0.0.1:${ORACLE_BROWSER_CDP_PORT}", template)
            self.assertNotIn("DISPLAY=:177", template)
            xvfb_template = (root / "etc/systemd/system/omnicodex-oracle-xvfb@.service").read_text()
            self.assertIn("EnvironmentFile=/etc/omnicodex-oracle-browser-%i.env", xvfb_template)
            self.assertIn("ExecStart=/usr/bin/Xvfb ${DISPLAY}", xvfb_template)
            self.assertEqual((root / "etc/systemd/system/omnicodex-oracle-browser@second.service.d/profile.conf").read_text(),
                             f"[Unit]\nRequires=omnicodex-oracle-xvfb@second.service\nAfter=omnicodex-oracle-xvfb@second.service\n\n[Service]\nReadWritePaths={profile}\n")
            # Existing four-argument reinstalls retain the saved independent display.
            retained = subprocess.run(command + ["second", str(profile), "19223"], env=env,
                                      text=True, capture_output=True, check=True)
            self.assertIn("display_requested=:178 restart_required=false", retained.stdout)
            self.assertEqual((root / "etc/omnicodex-oracle-browser-second.env").read_text(), second_env)
            for name, other_profile, port in (("duplicate-port", profile.parent / "third", "19223"),
                                              ("duplicate-profile", profile, "19224")):
                with self.subTest(instance=name):
                    failed = subprocess.run(command + [name, str(other_profile), port, "179"], env=env,
                                            text=True, capture_output=True)
                    self.assertEqual(failed.returncode, 78, failed.stderr)
                    self.assertIn("already assigned", failed.stderr)
            for display in ("177", "178"):
                with self.subTest(duplicate_display=display):
                    failed = subprocess.run(command + ["third", str(profile.parent / "third"), "19224", display],
                                            env=env, text=True, capture_output=True)
                    self.assertEqual(failed.returncode, 78, failed.stderr)
            for display in ("-1", ":178", "0178", "178 -other"):
                with self.subTest(invalid_display=display):
                    failed = subprocess.run(command + ["third", str(profile.parent / "third"), "19224", display],
                                            env=env, text=True, capture_output=True)
                    self.assertEqual(failed.returncode, 64, failed.stderr)
            changed = subprocess.run(command + ["second", str(profile), "19223", "179"], env=env,
                                     text=True, capture_output=True, check=True)
            self.assertIn("display_requested=:179 restart_required=true", changed.stdout)
            self.assertNotIn("restart ", service_log.read_text())
            # A deployed legacy four-argument instance may retain shared :177
            # until the operator explicitly supplies an independent display.
            legacy_env = root / "etc/omnicodex-oracle-browser-second.env"
            legacy_env.write_text("\n".join(line for line in legacy_env.read_text().splitlines()
                                            if not line.startswith("DISPLAY=")) + "\n")
            legacy = subprocess.run(command + ["second", str(profile), "19223"], env=env,
                                    text=True, capture_output=True, check=True)
            self.assertIn("display_requested=:177 restart_required=true", legacy.stdout)
            for path, contents in original.items():
                self.assertEqual(path.read_bytes(), contents)


if __name__ == "__main__":
    unittest.main()
