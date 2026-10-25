"""Generate cloud/.secrets.json and the firmware's cloud_settings.h.

Both come from cloud/.dev.vars; credentials are never printed.
"""

import argparse
import json
from pathlib import Path
from urllib.parse import urlparse

from cloud_client import RELAY_URL, ROOT, secrets


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("url", nargs="?", default=RELAY_URL, help="Relay origin")
    parser.add_argument(
        "ca",
        nargs="?",
        type=Path,
        default=ROOT / "cloud/root-ca.pem",
        help="Root CA bundle the board trusts",
    )
    args = parser.parse_args()
    url = args.url.rstrip("/")
    parsed = urlparse(url)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.path
        or parsed.query
        or parsed.fragment
    ):
        raise SystemExit("A deployed HTTPS origin is required.")
    certificate = args.ca.read_text(encoding="ascii")
    if "-----BEGIN CERTIFICATE-----" not in certificate:
        raise SystemExit("A root CA certificate in PEM format is required.")
    values = secrets()
    (ROOT / "cloud/.secrets.json").write_text(
        json.dumps({key: value for key, value in values.items() if value}),
        encoding="utf-8",
    )
    header = "#pragma once\n#define WAKE_CLOUD_URL " + json.dumps(url)
    header += "\n#define WAKE_DEVICE_TOKEN " + json.dumps(values["DEVICE_TOKEN"])
    header += '\nstatic const char WAKE_CA_CERT[] = R"CA(' + certificate + ')CA";\n'
    (ROOT / "firmware/src/cloud_settings.h").write_text(header, encoding="utf-8")
    print("Deployment inputs generated; credentials not displayed.")


if __name__ == "__main__":
    main()
