"""Update the board's firmware over the air through the relay.

Uploads the built image, then waits for the board to report it. The board
checks the image's SHA-256 and rolls back on its own if the new firmware
cannot reach the relay within five minutes.
"""

import argparse
import hashlib
import time
from pathlib import Path

from cloud_client import RELAY_URL, ROOT, Client

IMAGE = ROOT / "firmware/.pio/build/s3zero/firmware.bin"
# One app slot (app0/app1) in the default partition table.
MAX_IMAGE = 0x140000
WAIT_SECONDS = 300


def image_digest(image: bytes) -> str:
    """ESP-IDF appends the SHA-256 of the image; that digest names it."""
    if not 64 < len(image) <= MAX_IMAGE:
        raise SystemExit(f"Image must be at most {MAX_IMAGE} bytes.")
    digest = hashlib.sha256(image[:-32]).digest()
    if digest != image[-32:]:
        raise SystemExit("Image has no appended SHA-256; rebuild with PlatformIO.")
    return digest.hex()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", nargs="?", type=Path, default=IMAGE)
    parser.add_argument("--url", default=RELAY_URL, help="Relay origin")
    parser.add_argument(
        "--withdraw", action="store_true", help="Remove the offered image"
    )
    args = parser.parse_args()
    client = Client(args.url)
    if args.withdraw:
        client.send_firmware(None)
        print("Firmware offer withdrawn.")
        return
    image = args.image.read_bytes()
    digest = image_digest(image)
    board = client.call("/api/status", owner=True).get("board")
    if isinstance(board, dict) and board.get("firmware") == digest:
        raise SystemExit(f"Board already runs {digest[:8]}.")
    client.send_firmware(image, digest)
    print(f"Offered {digest[:8]} ({len(image)} bytes); waiting for the board.")
    deadline = time.monotonic() + WAIT_SECONDS
    while time.monotonic() < deadline:
        time.sleep(5)
        board = client.call("/api/status", owner=True).get("board")
        if isinstance(board, dict) and board.get("firmware") == digest:
            # A standing offer would pull a USB-flashed build back to this one.
            client.send_firmware(None)
            print(f"Board runs {digest[:8]}; offer withdrawn.")
            return
    raise SystemExit("Board did not report the new firmware within 5 minutes.")


if __name__ == "__main__":
    main()
