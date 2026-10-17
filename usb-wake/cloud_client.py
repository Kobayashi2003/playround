"""Local CLI client; keep credentials out of terminal output."""

import json
import ssl
from pathlib import Path
from typing import cast
from urllib.parse import urlparse
from urllib.request import HTTPSHandler, ProxyHandler, Request, build_opener

type Json = None | bool | int | float | str | list[Json] | dict[str, Json]
ROOT = Path(__file__).resolve().parent


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
    def __init__(self, base: str) -> None:
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
        with self.opener.open(request, timeout=15) as response:
            result: object = json.load(response)
        if not isinstance(result, dict):
            raise TypeError("Expected a JSON object from relay.")
        return cast(dict[str, Json], result)
