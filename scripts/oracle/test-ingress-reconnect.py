"""Exercise actual Caddy reconnect semantics on isolated loopback listeners."""

import concurrent.futures
import http.client
import http.server
import json
import os
import pathlib
import shutil
import socket
import subprocess
import tempfile
import threading
import time


def unused_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def installed_proxy_config(upstream_port):
    installer = pathlib.Path(__file__).with_name("install-ip-ingress.sh").read_text()
    prefix = "\t\treverse_proxy 127.0.0.1:$upstream_port {\n"
    body = installer.split(prefix, 1)[1].split("\n\t\t}", 1)[0]
    return f" reverse_proxy 127.0.0.1:{upstream_port} {{\n{body}\n }}\n"


def http_proxy_transports(value):
    if isinstance(value, dict):
        if value.get("protocol") == "http":
            yield value
        for child in value.values():
            yield from http_proxy_transports(child)
    elif isinstance(value, list):
        for child in value:
            yield from http_proxy_transports(child)


def test_certificate_challenge(caddy):
    """The installer's actual HTTP block must serve ACME before HTTPS redirects."""
    installer = pathlib.Path(__file__).with_name("install-ip-ingress.sh").read_text()
    template = installer.split('cat >"$final_fragment" <<CADDY\n', 1)[1]
    template = template.split("\nhttps://", 1)[0]
    with tempfile.TemporaryDirectory(prefix="omnicodex-acme-test-") as root:
        challenge = pathlib.Path(root, ".well-known", "acme-challenge", "probe")
        challenge.parent.mkdir(parents=True)
        challenge.write_text("certificate-validation-probe")
        port = unused_port()
        config = pathlib.Path(root, "Caddyfile")
        config.write_text(
            "{\n admin off\n auto_https off\n}\n"
            + template.replace("$public_ip", f"127.0.0.1:{port}")
            .replace("$webroot", root)
        )
        proxy = subprocess.Popen(
            [caddy, "run", "--config", str(config), "--adapter", "caddyfile"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        try:
            deadline = time.monotonic() + 8
            while True:
                if proxy.poll() is not None:
                    raise RuntimeError("ACME regression Caddy exited")
                try:
                    with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                        break
                except OSError:
                    if time.monotonic() >= deadline:
                        raise
                    time.sleep(0.05)
            for path, status, body in [
                ("/.well-known/acme-challenge/probe", 200, b"certificate-validation-probe"),
                ("/.well-known/acme-challenge/missing", 404, None),
                ("/mcp/full", 301, None),
            ]:
                connection = http.client.HTTPConnection("127.0.0.1", port, timeout=3)
                try:
                    connection.request("GET", path)
                    response = connection.getresponse()
                    actual_body = response.read()
                    assert response.status == status, (path, response.status, actual_body)
                    if body is not None:
                        assert actual_body == body
                    if status == 301:
                        assert response.getheader("Location") == f"https://127.0.0.1:{port}{path}"
                finally:
                    connection.close()
            print("ACME_HTTP_CHALLENGE_AND_NORMAL_REDIRECT_PASS", flush=True)
        finally:
            proxy.terminate()
            try:
                proxy.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proxy.kill()
                proxy.wait(timeout=5)


def main():
    caddy = os.environ.get("CADDY_BINARY") or shutil.which("caddy")
    if not caddy:
        raise RuntimeError("Installed Caddy is required")
    test_certificate_challenge(caddy)
    print(json.dumps({"caddyVersion": subprocess.check_output([caddy, "version"], text=True).strip()}), flush=True)
    proxy_port, upstream_port = unused_port(), unused_port()
    calls = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            calls.append((self.path, body))
            if self.path == "/lost-response":
                self.connection.shutdown(socket.SHUT_RDWR)
                self.connection.close()
                return
            self.send_response(503 if self.path == "/rejected" else 200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args):
            pass

    def request(path):
        connection = http.client.HTTPConnection("127.0.0.1", proxy_port, timeout=12)
        try:
            connection.request("POST", path, body=b"unchanged-native-request")
            response = connection.getresponse()
            return response.status, response.read()
        finally:
            connection.close()

    with tempfile.TemporaryDirectory(prefix="omnicodex-ingress-reconnect-") as root:
        config = pathlib.Path(root, "Caddyfile")
        # Use the same directives as the deployed ingress, with no TLS, admin
        # endpoint, public listener, or changes to the running Caddy service.
        config.write_text(
            "{\n admin off\n auto_https off\n}\n"
            f"http://127.0.0.1:{proxy_port} {{\n"
            + installed_proxy_config(upstream_port)
            + "}\n"
        )
        adapted = json.loads(subprocess.check_output(
            [caddy, "adapt", "--config", str(config), "--adapter", "caddyfile"],
            text=True, stderr=subprocess.DEVNULL,
        ))
        transports = list(http_proxy_transports(adapted))
        assert len(transports) == 1, transports
        assert transports[0].get("keep_alive", {}).get("idle_timeout") == 2_000_000_000, transports
        proxy = subprocess.Popen(
            [caddy, "run", "--config", str(config), "--adapter", "caddyfile"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        backend = None
        try:
            deadline = time.monotonic() + 8
            while True:
                if proxy.poll() is not None:
                    raise RuntimeError("Isolated Caddy exited before listening")
                try:
                    with socket.create_connection(("127.0.0.1", proxy_port), timeout=0.2):
                        break
                except OSError:
                    if time.monotonic() >= deadline:
                        raise RuntimeError("Isolated Caddy did not start")
                    time.sleep(0.05)
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
                pending = executor.submit(request, "/reconnect")
                time.sleep(0.8)
                assert not pending.done(), "Disconnected backhaul must retain the request"
                backend = http.server.ThreadingHTTPServer(("127.0.0.1", upstream_port), Handler)
                threading.Thread(target=backend.serve_forever, daemon=True).start()
                result = pending.result(timeout=8)
                assert result == (200, b"unchanged-native-request"), (result, calls)
            assert calls == [("/reconnect", b"unchanged-native-request")]
            assert request("/lost-response")[0] == 502
            assert request("/rejected") == (503, b"unchanged-native-request")
            time.sleep(0.3)
            assert [path for path, _ in calls] == ["/reconnect", "/lost-response", "/rejected"]
            print(json.dumps({"passed": ["unconnected POST retained and delivered once", "lost POST response not replayed", "HTTP rejection preserved without replay"]}))
        finally:
            if backend is not None:
                backend.shutdown()
                backend.server_close()
            proxy.terminate()
            try:
                proxy.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proxy.kill()
                proxy.wait(timeout=5)


if __name__ == "__main__":
    main()
