"""HTTPS client for the relay, authenticated with the management key.

Never print what secrets() returns.
"""

import json
import ssl
from pathlib import Path
from typing import cast
from urllib.parse import urlparse
from urllib.request import HTTPSHandler, ProxyHandler, Request, build_opener

type Json = None | bool | int | float | str | list[Json] | dict[str, Json]
ROOT = Path(__file__).resolve().parent.parent
RELAY_URL = "https://personal-usb-wake-entry.pages.dev"


def secrets() -> dict[str, str]:
    values = dict(
        line.split("=", 1)
        for line in (ROOT / "cloud/.dev.vars").read_text(encoding="utf-8").splitlines()
        if "=" in line and not line.startswith("#")
    )
    if any(len(values.get(key, "")) < 32 for key in ("ADMIN_TOKEN", "DEVICE_TOKEN")):
        raise ValueError("Local secrets are missing or invalid.")
    return values


class Client:
    def __init__(self, base: str = RELAY_URL) -> None:
        parsed = urlparse(base)
        if (
            parsed.scheme != "https"
            or not parsed.hostname
            or parsed.username
            or parsed.password
            or parsed.path not in ("", "/")
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError("An HTTPS origin is required.")
        self.base = base.rstrip("/")
        self.owner = secrets()["ADMIN_TOKEN"]
        context = ssl.create_default_context(cafile=str(ROOT / "cloud/root-ca.pem"))
        self.opener = build_opener(ProxyHandler({}), HTTPSHandler(context=context))
        self.opener.addheaders = [("User-Agent", "USB-Wake/1.0")]

    def call(
        self, path: str, body: dict[str, Json] | None = None, *, owner: bool = False
    ) -> dict[str, Json]:
        headers = {"Authorization": "Bearer " + self.owner} if owner else {}
        if body is not None:
            headers["Content-Type"] = "application/json"
        request = Request(
            self.base + path,
            data=None if body is None else json.dumps(body).encode(),
            headers=headers,
        )
        return self._send(request)

    def send_firmware(self, image: bytes | None, digest: str = "") -> dict[str, Json]:
        """Offer an image to the board (PUT), or withdraw the offer (None)."""
        request = Request(
            self.base + "/api/firmware",
            data=image,
            method="PUT" if image is not None else "DELETE",
            headers={
                "Authorization": "Bearer " + self.owner,
                "Content-Type": "application/octet-stream",
                "X-Firmware-Digest": digest,
            },
        )
        return self._send(request, timeout=120)

    def _send(self, request: Request, timeout: float = 15) -> dict[str, Json]:
        with self.opener.open(request, timeout=timeout) as response:
            result: object = json.load(response)
        if not isinstance(result, dict):
            raise TypeError("Expected a JSON object from relay.")
        return cast(dict[str, Json], result)
