"""Inspect the current HID board or request wake/bootloader mode."""

import argparse
from contextlib import closing

from board import open_board, text_report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group()
    action.add_argument(
        "--wake", action="store_true", help="Request a local network wake"
    )
    action.add_argument(
        "--bootloader", action="store_true", help="Enter the ROM USB downloader"
    )
    args = parser.parse_args()
    with closing(open_board()) as device:
        if args.bootloader or args.wake:
            device.send_feature_report(
                bytes([2, 255 if args.bootloader else 254]) + bytes(62)
            )
            print("Bootloader requested." if args.bootloader else "Wake requested.")
            return
        print("NETWORK", text_report(device, 200))
        print("CLOUD", text_report(device, 201))


if __name__ == "__main__":
    main()
