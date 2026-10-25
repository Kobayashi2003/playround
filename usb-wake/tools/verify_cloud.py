"""Verify HTTPS and access protection without sending any command."""

import argparse
import json
from urllib.error import HTTPError

from cloud_client import RELAY_URL, Client, Json


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("url", nargs="?", default=RELAY_URL, help="Relay origin")
    client = Client(parser.parse_args().url)
    for path, marker in (
        ("/", b"./app.js"),
        ("/app.js", b"api/status"),
        ("/styles.css", b"--"),
    ):
        with client.opener.open(client.base + path, timeout=15) as response:
            assert response.status == 200
            assert marker in response.read()
    state = client.call("/api/status", owner=True)
    unauthenticated: tuple[tuple[str, dict[str, Json] | None], ...] = (
        ("/api/status", None),
        ("/api/wake", {}),
        ("/api/action", {"action": "shutdown"}),
        ("/device/poll", {}),
        ("/device/socket", None),
    )
    for path, body in unauthenticated:
        try:
            client.call(path, body)
        except HTTPError as error:
            assert error.code == 401, error.code
        else:
            raise AssertionError("Privileged request accepted without authentication")
    print(
        "Verified HTTPS, assets, password protection, owner and device authentication."
    )
    print(json.dumps(state))


if __name__ == "__main__":
    main()
