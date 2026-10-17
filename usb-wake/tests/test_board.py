"""Validate provisioning against firmware's fixed 64-byte HID reports."""

import pytest

from board import config_reports


def test_utf8_credentials_round_trip_over_multiple_reports() -> None:
    ssid, password = "家" * 10 + "ab", "p" * 63
    reports = config_reports(ssid, password)
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
        config_reports(ssid, password)
