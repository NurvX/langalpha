"""The name a direct MCP tool is bound under, as the chat UI parses it back.

``direct_tool_name`` is the encode half of a pair whose decode half is
``parseDirectToolName`` in ``web/src/pages/ChatAgent/utils/directTools.ts``,
which splits on the first ``__`` after the prefix and hands the rest to the
tool detail panel and the approval card. ``_parse`` below mirrors it, so a
change to the Python half that the frontend could not read fails here.
"""

from __future__ import annotations

from src.server.services.egress.direct_tools import (
    _MAX_TOOL_NAME,
    direct_tool_name,
)

PREFIX = "mcp__"


def _parse(name: str) -> tuple[str, str]:
    assert name.startswith(PREFIX)
    rest = name[len(PREFIX) :]
    sep = rest.index("__")
    return rest[:sep], rest[sep + 2 :]


def test_name_is_the_prefix_the_frontend_splits_on():
    name = direct_tool_name("moomoo", "sim_trade_account_list")
    assert name == "mcp__moomoo__sim_trade_account_list"
    assert _parse(name) == ("moomoo", "sim_trade_account_list")


def test_a_long_server_is_truncated_and_the_tool_survives_verbatim():
    server = "a" * 80
    name = direct_tool_name(server, "trading_order_place")
    assert len(name) <= _MAX_TOOL_NAME
    parsed_server, parsed_tool = _parse(name)
    assert parsed_tool == "trading_order_place"
    assert server.startswith(parsed_server.rsplit("_", 1)[0])


def test_two_long_server_names_do_not_collide():
    assert direct_tool_name("a" * 80, "read_order") != direct_tool_name(
        "a" * 79 + "b", "read_order"
    )


def test_two_tools_on_one_long_server_do_not_collide():
    server = "a" * 80
    read = direct_tool_name(server, "read_order")
    cancel = direct_tool_name(server, "cancel_order")
    assert read != cancel
    assert _parse(read)[1] == "read_order"
    assert _parse(cancel)[1] == "cancel_order"
