"""PlatformIO pre-script: stamp each build with its UTC time (FIRMWARE_BUILD).

The board reports the stamp with its image digest, so the page shows which
build is running and every build gets a distinct digest for OTA.
"""

from datetime import UTC, datetime

Import("env")  # Provided by PlatformIO, like env below.

stamp = datetime.now(UTC).strftime("%Y-%m-%d %H:%M")
env.Append(CPPDEFINES=[("FIRMWARE_BUILD", f'\\"{stamp}\\"')])
