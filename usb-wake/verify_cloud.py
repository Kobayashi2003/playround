"""Verify HTTPS and optional access protection without sending wake commands."""

import json
import sys
from urllib.error import HTTPError

from cloud_client import Client


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: uv run verify_cloud.py https://deployed-host")
    client = Client(sys.argv[1])
    for path, marker in (
        ("/", b"./app.js"),
        ("/app.js", b"api/status"),
        ("/styles.css", b"--"),
    ):
        with client.opener.open(client.base + path, timeout=15) as response:
            assert response.status == 200
            assert marker in response.read()
    state = client.call("/api/status", owner=True)
    try:
        public = client.call("/api/status")
    except HTTPError as error:
        assert error.code == 401 and state["passwordRequired"] is True
    else:
        assert public["passwordRequired"] is False
    for path in ("/api/settings", "/device/poll"):
        try:
            client.call(path, {})
        except HTTPError as error:
            assert error.code == 401, error.code
        else:
            raise AssertionError("Privileged request accepted without authentication")
    print("Verified HTTPS, assets, access mode, owner and device authentication.")
    print(json.dumps(state))


if __name__ == "__main__":
    main()
