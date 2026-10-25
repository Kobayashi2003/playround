"""Validate agent.toml handling without touching the board."""

import json
from pathlib import Path

import pytest

from agent import ROOT, load_config


def test_shipped_config_offers_power_actions() -> None:
    config = load_config(ROOT / "agent.toml")
    assert list(config.actions)[:4] == ["shutdown", "hibernate", "restart", "sleep"]
    assert all(config.actions[name].confirm for name in list(config.actions)[:4])
    catalogue = json.loads(config.catalogue())
    assert catalogue[0] == {"id": "shutdown", "label": "Shut down", "confirm": True}


@pytest.mark.parametrize(
    "body",
    [
        "",
        '[[action]]\nid = "Bad Id"\nlabel = "x"\ncommand = ["a"]',
        '[[action]]\nid = "a"\nlabel = ""\ncommand = ["a"]',
        '[[action]]\nid = "a"\nlabel = "x"\ncommand = []',
        '[[action]]\nid = "a"\nlabel = "x"\ncommand = "shutdown /s"',
        (
            '[[action]]\nid = "a"\nlabel = "x"\ncommand = ["a"]\n'
            '[[action]]\nid = "a"\nlabel = "y"\ncommand = ["b"]'
        ),
        '[agent]\npoll_interval = 10\n[[action]]\nid = "a"\nlabel = "x"\ncommand = ["a"]',
    ],
)
def test_invalid_configs_are_rejected(tmp_path: Path, body: str) -> None:
    path = tmp_path / "agent.toml"
    path.write_text(body, encoding="utf-8")
    with pytest.raises(ValueError):
        load_config(path)


def test_catalogue_must_fit_the_board(tmp_path: Path) -> None:
    entries = "\n".join(
        f'[[action]]\nid = "action-{i:02}-{"x" * 20}"\nlabel = "{"L" * 40}"\n'
        'command = ["a"]'
        for i in range(16)
    )
    path = tmp_path / "agent.toml"
    path.write_text(entries, encoding="utf-8")
    with pytest.raises(ValueError, match="too long"):
        load_config(path)
