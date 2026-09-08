"""The direct-tool gate: refuses on the port's word, passes everything else."""

from __future__ import annotations

import pytest
from langchain_core.messages import ToolMessage
from langchain_core.tools import StructuredTool

from ptc_agent.agent.middleware.direct_mcp import (
    METADATA_KEY,
    DirectMcpPolicyMiddleware,
    direct_tool_summary,
)


def _tool(name: str, *, stamp: dict | None) -> StructuredTool:
    tool = StructuredTool.from_function(func=lambda: "ok", name=name, description="t")
    if stamp is not None:
        tool.metadata = {METADATA_KEY: stamp}
    return tool


class _Request:
    def __init__(self, name: str) -> None:
        self.tool_call = {"id": "call-1", "name": name, "args": {}}


class _ToolSet:
    def __init__(self, tools, reason=None):
        self.tools = tools
        self.reason = reason
        self.asked: list[tuple[str, str]] = []

    async def check(self, server, tool):
        self.asked.append((server, tool))
        return self.reason


async def _ran(request):
    return ToolMessage(content="ran", tool_call_id=request.tool_call["id"])


DIRECT = _tool(
    "mcp__moomoo__sim_trade_input_order",
    stamp={"server": "moomoo", "tool": "sim_trade_input_order"},
)


@pytest.mark.asyncio
async def test_unstamped_tool_passes_without_consulting_the_port():
    toolset = _ToolSet([DIRECT], reason="never")
    mw = DirectMcpPolicyMiddleware(toolset)
    out = await mw.awrap_tool_call(_Request("web_search"), _ran)
    assert out.content == "ran"
    assert toolset.asked == []


@pytest.mark.asyncio
async def test_direct_tool_runs_when_the_port_allows_it():
    toolset = _ToolSet([DIRECT])
    mw = DirectMcpPolicyMiddleware(toolset)
    out = await mw.awrap_tool_call(_Request(DIRECT.name), _ran)
    assert out.content == "ran"
    assert toolset.asked == [("moomoo", "sim_trade_input_order")]


@pytest.mark.asyncio
async def test_direct_tool_is_refused_with_the_ports_reason():
    mw = DirectMcpPolicyMiddleware(_ToolSet([DIRECT], reason="consent withdrawn"))
    out = await mw.awrap_tool_call(_Request(DIRECT.name), _ran)
    assert isinstance(out, ToolMessage)
    assert out.status == "error"
    assert out.tool_call_id == "call-1"
    assert out.content == "Refused: consent withdrawn"


def test_sync_path_fails_closed_for_direct_tools_only():
    mw = DirectMcpPolicyMiddleware(_ToolSet([DIRECT]))
    ran = mw.wrap_tool_call(
        _Request("web_search"),
        lambda r: ToolMessage(content="ran", tool_call_id="call-1"),
    )
    assert ran.content == "ran"
    refused = mw.wrap_tool_call(
        _Request(DIRECT.name),
        lambda r: ToolMessage(content="ran", tool_call_id="call-1"),
    )
    assert refused.status == "error"


class TestDirectToolSummaryImportHint:
    """A `both` tool's line has to name the symbol the wrapper actually defines."""

    def test_a_direct_only_tool_is_not_offered_an_import(self):
        line = direct_tool_summary(
            [
                _tool(
                    "mcp__moomoo__place",
                    stamp={
                        "server": "moomoo",
                        "tool": "trading_order_place",
                        "sandboxed": False,
                    },
                )
            ]
        )
        assert "importable" not in line

    def test_the_hint_uses_the_generated_name_not_the_vendor_name(self):
        # The wrapper is emitted under _safe_func_name, so a vendor name with
        # illegal characters is a different symbol in the module.
        line = direct_tool_summary(
            [
                _tool(
                    "mcp__acme__odd",
                    stamp={"server": "acme", "tool": "weird-name.v2", "sandboxed": True},
                )
            ]
        )
        assert "`tools.acme.weird_name_v2`" in line
        assert "weird-name.v2`" not in line

    def test_a_name_with_no_legal_form_loses_the_hint(self):
        line = direct_tool_summary(
            [_tool("mcp__acme__bad", stamp={"server": "acme", "tool": "---", "sandboxed": True})]
        )
        assert "importable" not in line
