"""Show the board's status, set its wake target, or send it a command."""

import argparse
import time
from contextlib import closing

from board import (
    COMMAND_BOOTLOADER,
    COMMAND_WAKE,
    PAGE_AGENT,
    PAGE_BOARD,
    PAGE_CLOUD,
    PAGE_NETWORK,
    PAGE_TARGET,
    open_board,
    report,
    send,
    target_mac_report,
    text_report,
)

PAGES = {
    "NETWORK": PAGE_NETWORK,
    "CLOUD": PAGE_CLOUD,
    "TARGET": PAGE_TARGET,
    "BOARD": PAGE_BOARD,
    "AGENT": PAGE_AGENT,
}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--wake", action="store_true", help="Send Wake-on-LAN now")
    action.add_argument(
        "--bootloader", action="store_true", help="Enter the ROM USB downloader"
    )
    action.add_argument(
        "--target-mac", metavar="MAC", help="Set the PC adapter to wake"
    )
    args = parser.parse_args()
    with closing(open_board()) as device:
        if args.target_mac:
            send(device, target_mac_report(args.target_mac))
            time.sleep(0.5)
            print("TARGET", text_report(device, PAGE_TARGET))
        elif args.wake:
            send(device, report(COMMAND_WAKE))
            print("Wake requested.")
        elif args.bootloader:
            send(device, report(COMMAND_BOOTLOADER))
            print("Bootloader requested.")
        else:
            for name, page in PAGES.items():
                print(name, text_report(device, page))


if __name__ == "__main__":
    main()
