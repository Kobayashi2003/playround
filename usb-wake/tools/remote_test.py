"""Send one real wake through the relay and wait for the board's result."""

import argparse
import time

from cloud_client import RELAY_URL, Client


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("url", nargs="?", default=RELAY_URL, help="Relay origin")
    client = Client(parser.parse_args().url)
    if not client.call("/api/status", owner=True)["online"]:
        raise SystemExit("Board is offline; no wake command sent.")
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
            print("Board result:", result["status"], flush=True)
            if result["status"] != "sent":
                raise SystemExit(1)
            return
    raise SystemExit("No successful acknowledgement within 25 seconds.")


if __name__ == "__main__":
    main()
