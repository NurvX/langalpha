"""Links relayed into a Flash thread must name the workspace that holds the file."""

import pytest

from src.tools.secretary.utils import _qualify_file_paths

WID = "20cc68e8-d057-41f4-9bb1-57aa8d310704"
Q = f"__wsref__/{WID}"


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("[r](results/report.md)", f"[r]({Q}/results/report.md)"),
        ("![c](work/t/charts/r.png)", f"![c]({Q}/work/t/charts/r.png)"),
        ("[r](file:///home/workspace/results/report.md)", f"[r]({Q}/results/report.md)"),
        ("[r](/home/daytona/results/report.md)", f"[r]({Q}/results/report.md)"),
        ("[m](model.py)", f"[m]({Q}/model.py)"),
        ("[m](./work/model.py:42)", f"[m]({Q}/work/model.py:42)"),
        ("[m](model.py:40-55)", f"[m]({Q}/model.py:40-55)"),
        ("[v](results/notes.md#valuation)", f"[v]({Q}/results/notes.md#valuation)"),
        ("[d](<results/Q3 deck.pptx>)", f"[d](<{Q}/results/Q3 deck.pptx>)"),
        ("[d](results/Q3 deck.pptx)", f"[d](<{Q}/results/Q3 deck.pptx>)"),
        ("[d](<file:///home/workspace/Q3 deck.pptx#page=2>)", f"[d](<{Q}/Q3 deck.pptx#page=2>)"),
    ],
)
def test_qualifies_workspace_file_links(text, expected):
    assert _qualify_file_paths(text, WID) == expected


@pytest.mark.parametrize(
    "text",
    [
        "[g](https://example.com/report.md)",
        "[e](mailto:a@example.com)",
        "[s](#summary)",
        "[s](localhost:8000)",
        "[s](127.0.0.1:8000)",
        "[t](/etc/hosts.txt)",
        "[x](notes about things)",
        "[t](results/a.md \"a title\")",
        f"[r]({Q}/results/report.md)",
        "[other](__wsref__/11111111-2222-3333-4444-555555555555/a.md)",
    ],
)
def test_leaves_non_workspace_links_alone(text):
    assert _qualify_file_paths(text, WID) == text


def test_rewrites_every_link_in_a_reply():
    text = "See [a](a.md) and [b](https://x.io) then ![c](charts/c.png)."
    assert _qualify_file_paths(text, WID) == (
        f"See [a]({Q}/a.md) and [b](https://x.io) then ![c]({Q}/charts/c.png)."
    )
