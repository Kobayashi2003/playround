"""Shared HID transport and byte-oriented Wi-Fi provisioning protocol."""

import hid


def open_board() -> hid.device:
    matches = [
        item
        for item in hid.enumerate(0x303A, 0x1001)
        if item.get("serial_number") == "S3ZERO-WAKE-BOOT03"
        and item.get("usage_page") == 0xFF00
    ]
    if len(matches) != 1:
        raise RuntimeError("Expected one connected USB wake board.")
    device = hid.device()
    device.open_path(matches[0]["path"])
    return device


def text_report(device: hid.device, page: int) -> str:
    device.send_feature_report(bytes([2, page]) + bytes(62))
    data = bytes(device.get_feature_report(2, 64))
    if len(data) != 64 or data[0] != 2:
        raise RuntimeError("Unexpected HID feature report.")
    return data[1:].split(b"\0", 1)[0].decode("ascii", errors="replace")


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
    return (bytes([2, 252]) + address).ljust(64, b"\0")


def config_reports(ssid: str, password: str) -> list[bytes]:
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
        (bytes([2, 253, offset, len(payload)]) + payload[offset : offset + 60]).ljust(
            64, b"\0"
        )
        for offset in range(0, len(payload), 60)
    ]
