"""Generate private deployment inputs; never print credentials."""

import json
import sys
from pathlib import Path
from urllib.parse import urlparse

from cloud_client import ROOT, secrets


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit(
            "Usage: uv run prepare_cloud.py https://worker-host root-ca.pem"
        )
    url = sys.argv[1].rstrip("/")
    parsed = urlparse(url)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.path
        or parsed.query
        or parsed.fragment
        or parsed.hostname.endswith(".invalid")
    ):
        raise SystemExit("A deployed HTTPS origin is required.")
    certificate = Path(sys.argv[2]).read_text(encoding="ascii")
    if (
        "-----BEGIN CERTIFICATE-----" not in certificate
        or "-----END CERTIFICATE-----" not in certificate
    ):
        raise SystemExit("A trusted root CA certificate in PEM format is required.")
    root = ROOT
    values = secrets()
    (root / "cloud/.secrets.json").write_text(json.dumps(values), encoding="utf-8")
    header = "#pragma once\n#define WAKE_CLOUD_URL " + json.dumps(url)
    header += "\n#define WAKE_DEVICE_TOKEN " + json.dumps(values["DEVICE_TOKEN"])
    header += '\nstatic const char WAKE_CA_CERT[] = R"CA(' + certificate + ')CA";\n'
    (root / "firmware/src/cloud_settings.h").write_text(header, encoding="utf-8")
    (root / "cloud/CONTROL-ACCESS.txt").write_text(
        "Control page: " + url + "\nManagement key: " + values["ADMIN_TOKEN"] + "\n",
        encoding="utf-8",
    )
    print("Deployment inputs generated; credentials not displayed.")


if __name__ == "__main__":
    main()
