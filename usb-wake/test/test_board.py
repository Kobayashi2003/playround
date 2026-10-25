"""Validate provisioning against firmware's fixed 64-byte HID reports."""

import uuid

import pytest

from board import (
    Poll,
    catalogue_reports,
    poll,
    result_report,
    target_mac_report,
    wifi_reports,
)


def test_utf8_credentials_round_trip_over_multiple_reports() -> None:
    ssid, password = "家" * 10 + "ab", "p" * 63
    reports = wifi_reports(ssid, password)
    assert len(reports) == 2
    payload = b""
    for index, report in enumerate(reports):
        assert len(report) == 64
        assert report[:3] == bytes([2, 253, index * 60])
        assert report[3] == 97
        payload += report[4 : 4 + min(60, report[3] - index * 60)]
    assert payload == bytes([32, 63]) + ssid.encode() + password.encode()


@pytest.mark.parametrize(
    "ssid,password",
    [
        ("", "12345678"),
        ("家" * 11, "12345678"),
        ("wifi", "short"),
        ("wifi", "a" * 64),
        ("wi\0fi", "12345678"),
    ],
)
def test_invalid_credentials_never_produce_reports(ssid: str, password: str) -> None:
    with pytest.raises(ValueError):
        wifi_reports(ssid, password)


def test_target_mac_report_matches_firmware_layout() -> None:
    report = target_mac_report("58-11-22-ab-1c-c8")
    assert len(report) == 64
    assert report[:8] == bytes([2, 252, 0x58, 0x11, 0x22, 0xAB, 0x1C, 0xC8])
    assert report[8:] == bytes(56)


@pytest.mark.parametrize(
    "mac",
    [
        "",
        "58:11:22:AB:1C",
        "58:11:22:AB:1C:ZZ",
        "FF:FF:FF:FF:FF:FF",
        "5811:22:AB:1C:C8:00",
    ],
)
def test_invalid_target_mac_is_rejected(mac: str) -> None:
    with pytest.raises(ValueError):
        target_mac_report(mac)


def test_poll_parses_waiting_command() -> None:
    command_id = "3e3236b5-2cde-49a9-ae7f-5dec84dcd15b"
    payload = bytes([0xA5, 0x03]) + uuid.UUID(command_id).bytes + b"shutdown"
    device = FakeDevice(bytes([2]) + payload.ljust(63, b"\0"))
    assert poll(device) == Poll(True, command_id, "shutdown")
    assert device.sent[0][:2] == bytes([2, 204])


def test_poll_ignores_pages_set_by_other_tools() -> None:
    device = FakeDevice(bytes([2]) + b"cfg=1 up=1".ljust(63, b"\0"))
    assert poll(device) is None


def test_catalogue_and_result_reports_match_firmware_layout() -> None:
    payload = bytes(range(100))
    reports = catalogue_reports(payload)
    assert [len(report) for report in reports] == [64, 64]
    assert reports[1][:6] == bytes([2, 250, 58, 0, 100, 0])
    assert reports[0][6:64] + reports[1][6 : 6 + 42] == payload
    with pytest.raises(ValueError):
        catalogue_reports(bytes(1025))
    command_id = "3e3236b5-2cde-49a9-ae7f-5dec84dcd15b"
    report = result_report(command_id, True)
    assert report[:3] == bytes([2, 251, 1])
    assert report[3:19] == uuid.UUID(command_id).bytes


class FakeDevice:
    def __init__(self, reply: bytes) -> None:
        self.reply = reply
        self.sent: list[bytes] = []

    def send_feature_report(self, data: bytes) -> int:
        self.sent.append(data)
        return len(data)

    def get_feature_report(self, report_id: int, max_length: int) -> list[int]:
        return list(self.reply)
