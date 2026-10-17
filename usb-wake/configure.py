"""One-use loopback Wi-Fi provisioning page. Credentials go only to the board."""

import secrets
import time
from contextlib import closing
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs

from board import config_reports, open_board, text_report

csrf_token = secrets.token_urlsafe(32)
finished = False


def network_status() -> str:
    with closing(open_board()) as device:
        return text_report(device, 200)


def write_config(ssid: str, password: str) -> None:
    with closing(open_board()) as device:
        for report in config_reports(ssid, password):
            device.send_feature_report(report)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:
        pass

    def respond(self, body: str, status: int = 200) -> None:
        encoded = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
        )
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self) -> None:
        if self.path != "/":
            self.respond("Not found", 404)
            return
        self.respond(
            """<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Wi-Fi Setup</title>
<style>body{font:17px system-ui;max-width:480px;margin:60px auto;padding:24px;color:#20262e;background:#f5f7fa}label{display:block;margin:22px 0 8px}input,button{box-sizing:border-box;width:100%;padding:13px;font:inherit;border:1px solid #b5bec9;border-radius:8px}button{margin-top:28px;background:#174b82;color:white;cursor:pointer}p{line-height:1.7;color:#536172}</style>
<h1>Wi-Fi Setup</h1><p>Use a 2.4 GHz network on the same LAN as your PC.</p>
<form method="post" action="/configure"><input type="hidden" name="csrf" value="""
            + f'"{csrf_token}">'
            + """
<label for="ssid">Network name</label><input id="ssid" name="ssid" required autocomplete="off">
<label for="password">Password</label><input id="password" name="password" type="password" required autocomplete="off">
<button type="submit">Connect</button></form></html>"""
        )

    def do_POST(self) -> None:
        global finished
        assert isinstance(self.server, HTTPServer)
        expected_origin = f"http://127.0.0.1:{self.server.server_port}"
        if self.path != "/configure" or self.headers.get("Origin") != expected_origin:
            self.respond("Invalid request", 403)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.respond("Invalid request", 400)
            return
        if not 0 < length <= 2048:
            self.respond("Invalid request", 400)
            return
        try:
            fields = parse_qs(
                self.rfile.read(length).decode("utf-8"), keep_blank_values=True
            )
        except UnicodeDecodeError:
            self.respond("Invalid request", 400)
            return
        if not secrets.compare_digest(fields.get("csrf", [""])[0], csrf_token):
            self.respond("Invalid request", 403)
            return
        try:
            write_config(fields.get("ssid", [""])[0], fields.get("password", [""])[0])
            connected = False
            for _ in range(20):
                time.sleep(1)
                if "up=1" in network_status():
                    connected = True
                    break
            if connected:
                self.respond(
                    "<meta charset=utf-8><h1>Connected</h1><p>Setup complete. You can close this page.</p>"
                )
                print("Wi-Fi connected; credentials not logged.", flush=True)
                finished = True
            else:
                self.respond(
                    "<meta charset=utf-8><h1>Connection failed</h1><p>Check your 2.4 GHz network and password, then go back to retry.</p>",
                    400,
                )
                print(
                    "Wi-Fi not connected within 20 seconds; retry available.",
                    flush=True,
                )
        except ValueError as error:
            self.respond(f"<meta charset=utf-8><h1>{error}</h1>", 400)
        except OSError, RuntimeError:
            self.respond(
                "<meta charset=utf-8><h1>USB communication failed. Check the connection.</h1>",
                500,
            )
            print("USB provisioning error; no credential data logged.", flush=True)


def main() -> None:
    with closing(open_board()):
        pass
    with HTTPServer(("127.0.0.1", 16032), Handler) as server:
        server.timeout = 1
        print(f"Configuration page: http://127.0.0.1:{server.server_port}/", flush=True)
        while not finished:
            server.handle_request()


if __name__ == "__main__":
    main()
