"""PC agent: runs the actions in agent.toml when the web page asks for them.

It talks only to the wake board over USB, with no network access or
credentials. It runs in the signed-in session (install_agent.ps1 registers a
logon task) so launched programs appear on the desktop.
"""

import argparse
import json
import logging
import re
import shutil
import subprocess
import threading
import time
import tomllib
from contextlib import closing
from dataclasses import dataclass
from pathlib import Path

from board import (
    MAX_CATALOGUE_BYTES,
    catalogue_reports,
    open_board,
    poll,
    result_report,
    send,
)

ROOT = Path(__file__).resolve().parent.parent
STATE = ROOT / ".agent-state.json"
ACTION_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}$")
MAX_ACTIONS = 16
MAX_LABEL = 40
# Seconds to wait before retrying when the board is unplugged or busy.
RECONNECT_SECONDS = 5.0

log = logging.getLogger("agent")


@dataclass(frozen=True)
class Action:
    id: str
    label: str
    command: list[str]
    confirm: bool
    delay: float


@dataclass(frozen=True)
class Config:
    poll_interval: float
    actions: dict[str, Action]

    def catalogue(self) -> bytes:
        """The compact JSON the board forwards to the web page."""
        items = [
            {"id": a.id, "label": a.label, "confirm": a.confirm}
            for a in self.actions.values()
        ]
        return json.dumps(items, ensure_ascii=False, separators=(",", ":")).encode()


def load_config(path: Path) -> Config:
    data = tomllib.loads(path.read_text(encoding="utf-8"))
    interval = float(data.get("agent", {}).get("poll_interval", 1.0))
    if not 0.2 <= interval <= 3:
        raise ValueError("poll_interval must be 0.2–3 seconds.")
    raw = data.get("action", [])
    if not isinstance(raw, list) or not 1 <= len(raw) <= MAX_ACTIONS:
        raise ValueError(f"Define 1–{MAX_ACTIONS} [[action]] entries.")
    actions: dict[str, Action] = {}
    for item in raw:
        action_id, label, command = (
            item.get("id"),
            item.get("label"),
            item.get("command"),
        )
        if not isinstance(action_id, str) or not ACTION_ID.match(action_id):
            raise ValueError(f"Invalid action id: {action_id!r}")
        if action_id in actions:
            raise ValueError(f"Duplicate action id: {action_id}")
        if not isinstance(label, str) or not 1 <= len(label) <= MAX_LABEL:
            raise ValueError(f"{action_id}: label must be 1–{MAX_LABEL} characters.")
        if (
            not isinstance(command, list)
            or not command
            or not all(isinstance(part, str) and part for part in command)
        ):
            raise ValueError(f"{action_id}: command must be a non-empty string list.")
        delay = float(item.get("delay", 0))
        if not 0 <= delay <= 60:
            raise ValueError(f"{action_id}: delay must be 0–60 seconds.")
        actions[action_id] = Action(
            action_id, label, command, bool(item.get("confirm", False)), delay
        )
    config = Config(interval, actions)
    if len(config.catalogue()) > MAX_CATALOGUE_BYTES:
        raise ValueError("Actions are too long; shorten labels or ids.")
    return config


def last_handled() -> str | None:
    try:
        value = json.loads(STATE.read_text(encoding="utf-8")).get("lastHandled")
    except OSError, ValueError:
        return None
    return value if isinstance(value, str) else None


def remember(command_id: str) -> None:
    STATE.write_text(json.dumps({"lastHandled": command_id}), encoding="utf-8")


def start(action: Action) -> bool:
    """Check the program exists, then launch it (after its delay) detached."""
    if shutil.which(action.command[0]) is None:
        log.error("%s: program not found: %s", action.id, action.command[0])
        return False

    def launch() -> None:
        try:
            subprocess.Popen(
                action.command,
                cwd=ROOT,
                creationflags=subprocess.CREATE_NO_WINDOW,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            log.info("%s: started", action.id)
        except OSError:
            log.exception("%s: failed to start", action.id)

    if action.delay:
        threading.Timer(action.delay, launch).start()
    else:
        launch()
    return True


def serve(config: Config) -> None:
    done = last_handled()
    with closing(open_board()) as device:

        def offer() -> None:
            for report in catalogue_reports(config.catalogue()):
                send(device, report)

        log.info("Board connected; offering %d actions.", len(config.actions))
        # Also on connect: the board may still hold an older agent.toml's list.
        offer()
        while True:
            state = poll(device)
            if state and state.need_catalogue:
                offer()
            if state and state.command_id and state.command_id != done:
                # Remember first: a crash must never run the same command twice.
                done = state.command_id
                remember(done)
                action = config.actions.get(state.action or "")
                ok = action is not None and start(action)
                if action is None:
                    log.error("Unknown action %r; agent.toml changed?", state.action)
                send(device, result_report(done, ok))
            time.sleep(config.poll_interval)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--config", type=Path, default=ROOT / "agent.toml", help="Actions file"
    )
    parser.add_argument(
        "--check", action="store_true", help="Validate the config and exit"
    )
    args = parser.parse_args()
    config = load_config(args.config)
    if args.check:
        print(f"{len(config.actions)} actions OK: {', '.join(config.actions)}")
        return
    (ROOT / ".logs").mkdir(exist_ok=True)
    logging.basicConfig(
        filename=ROOT / ".logs" / "agent.log",
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    while True:
        try:
            serve(config)
        except OSError, RuntimeError:
            log.warning("Board unavailable; retrying.", exc_info=True)
            time.sleep(RECONNECT_SECONDS)


if __name__ == "__main__":
    main()
