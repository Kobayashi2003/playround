"""USB HID protocol of the wake board; mirrors firmware/src/hid_protocol.h."""

import uuid
from dataclasses import dataclass
from typing import Protocol

import hid

VENDOR_ID, PRODUCT_ID = 0x303A, 0x1001
# config::kUsbSerial in firmware/src/config.h.
SERIAL = "S3ZERO-WAKE-BOOT03"
REPORT_ID = 2
REPORT_BYTES = 64  # Report ID plus 63 payload bytes.

PAGE_NETWORK = 200
PAGE_CLOUD = 201
PAGE_TARGET = 202
PAGE_BOARD = 203
PAGE_POLL = 204
PAGE_AGENT = 205
POLL_MAGIC = 0xA5

COMMAND_CATALOGUE = 250
COMMAND_RESULT = 251
COMMAND_TARGET_MAC = 252
COMMAND_WIFI = 253
COMMAND_WAKE = 254
COMMAND_BOOTLOADER = 255

# config::kMaxCatalogueBytes in firmware/src/config.h.
MAX_CATALOGUE_BYTES = 1024
CATALOGUE_CHUNK = 58
WIFI_CHUNK = 60


class FeatureDevice(Protocol):
    def send_feature_report(self, data: bytes) -> int: ...
    def get_feature_report(self, report_id: int, max_length: int) -> list[int]: ...


@dataclass(frozen=True)
class Poll:
    need_catalogue: bool
    command_id: str | None
    action: str | None


def open_board() -> hid.device:
    matches = [
        item
        for item in hid.enumerate(VENDOR_ID, PRODUCT_ID)
        if item.get("serial_number") == SERIAL and item.get("usage_page") == 0xFF00
    ]
    if len(matches) != 1:
        raise RuntimeError("Expected one connected USB wake board.")
    device = hid.device()
    device.open_path(matches[0]["path"])
    return device


def report(command: int, data: bytes = b"") -> bytes:
    """A feature report write: a command with its data, or a page selection."""
    if len(data) > REPORT_BYTES - 2:
        raise ValueError("Report data exceeds 62 bytes.")
    return bytes([REPORT_ID, command]) + data.ljust(REPORT_BYTES - 2, b"\0")


def send(device: FeatureDevice, data: bytes) -> None:
    """hidapi signals a failed write with -1 instead of raising."""
    if device.send_feature_report(data) < 0:
        raise OSError("HID feature report write failed.")


def read_page(device: FeatureDevice, page: int) -> bytes:
    send(device, report(page))
    data = bytes(device.get_feature_report(REPORT_ID, REPORT_BYTES))
    if len(data) != REPORT_BYTES or data[0] != REPORT_ID:
        raise RuntimeError("Unexpected HID feature report.")
    return data[1:]


def text_report(device: FeatureDevice, page: int) -> str:
    return read_page(device, page).split(b"\0", 1)[0].decode("ascii", "replace")


def poll(device: FeatureDevice) -> Poll | None:
    """Read the agent poll page; None when another tool switched the page."""
    data = read_page(device, PAGE_POLL)
    if data[0] != POLL_MAGIC:
        return None
    need_catalogue, has_command = bool(data[1] & 0x01), bool(data[1] & 0x02)
    if not has_command:
        return Poll(need_catalogue, None, None)
    action = data[18:].split(b"\0", 1)[0].decode("ascii", "replace")
    return Poll(need_catalogue, str(uuid.UUID(bytes=data[2:18])), action)


def target_mac_report(mac: str) -> bytes:
    parts = mac.replace("-", ":").split(":")
    if len(parts) != 6 or any(len(part) != 2 for part in parts):
        raise ValueError("MAC address must look like 58:11:22:AB:1C:C8.")
    try:
        address = bytes(int(part, 16) for part in parts)
    except ValueError:
        raise ValueError("MAC address must contain hexadecimal bytes.") from None
    if address[0] & 1:
        raise ValueError("MAC address must belong to a single adapter.")
    return report(COMMAND_TARGET_MAC, address)


def wifi_reports(ssid: str, password: str) -> list[bytes]:
    ssid_bytes, password_bytes = ssid.encode("utf-8"), password.encode("utf-8")
    if not 1 <= len(ssid_bytes) <= 32:
        raise ValueError("SSID must contain 1–32 UTF-8 bytes.")
    if not 8 <= len(password_bytes) <= 63:
        raise ValueError("Wi-Fi password must contain 8–63 UTF-8 bytes.")
    if b"\0" in ssid_bytes or b"\0" in password_bytes:
        raise ValueError("SSID and password cannot contain null characters.")
    payload = (
        bytes([len(ssid_bytes), len(password_bytes)]) + ssid_bytes + password_bytes
    )
    return [
        report(
            COMMAND_WIFI,
            bytes([offset, len(payload)]) + payload[offset : offset + WIFI_CHUNK],
        )
        for offset in range(0, len(payload), WIFI_CHUNK)
    ]


def catalogue_reports(payload: bytes) -> list[bytes]:
    if not 0 < len(payload) <= MAX_CATALOGUE_BYTES:
        raise ValueError(f"Action catalogue must be 1–{MAX_CATALOGUE_BYTES} bytes.")
    total = len(payload).to_bytes(2, "little")
    return [
        report(
            COMMAND_CATALOGUE,
            offset.to_bytes(2, "little")
            + total
            + payload[offset : offset + CATALOGUE_CHUNK],
        )
        for offset in range(0, len(payload), CATALOGUE_CHUNK)
    ]


def result_report(command_id: str, ok: bool) -> bytes:
    return report(COMMAND_RESULT, bytes([1 if ok else 0]) + uuid.UUID(command_id).bytes)
