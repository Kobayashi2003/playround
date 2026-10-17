"""Send one real wake command and wait for the board's acknowledgement."""

import sys
import time

from cloud_client import Client


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: uv run remote_test.py https://deployed-host")
    client = Client(sys.argv[1])
    if not client.call("/api/status", owner=True)["online"]:
        raise SystemExit("Device is offline; no wake command sent.")
    command = client.call("/api/wake", {}, owner=True)["command"]
    if not isinstance(command, dict):
        raise TypeError("Missing command in relay response.")
    print("One cloud command created; waiting for acknowledgement.", flush=True)
    deadline = time.monotonic() + 25
    while time.monotonic() < deadline:
        time.sleep(2)
        result = client.call("/api/status", owner=True)["command"]
        if (
            isinstance(result, dict)
            and result["id"] == command["id"]
            and result["status"] != "pending"
        ):
            print("Cloud device acknowledgement:", result["status"], flush=True)
            if result["status"] != "sent":
                raise SystemExit(1)
            return
    raise SystemExit("No successful acknowledgement within 25 seconds.")


if __name__ == "__main__":
    main()
