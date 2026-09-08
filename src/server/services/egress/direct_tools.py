"""Directly bound MCP tools: JSON tool calls from the model, through the relay.

The sandbox path hands the model a Python wrapper per MCP tool and lets it
compose them in ``ExecuteCode``. The direct path binds the tool itself, with
its vendor schema verbatim, so a call is one typed tool call the middleware
sees and the UI can render. Both paths reach the vendor through the same
egress grant and the same relay route: the host dials its own relay on
loopback with a relay JWT, so policy, token attach and audit are one code
path however the call arrived.

The relay sessions are opened inside the run, not the request. The graph is
driven by the run manager's task and outlives the request's generator when
the client drops, and the transport's session lives in the task that entered
it, so the sessions are entered and closed by ``drive`` around the run
stream itself. Between them the client is held open, so each call reuses
one session instead of paying a handshake through the relay.
"""

from __future__ import annotations

import logging
import re
import warnings
from collections.abc import AsyncIterator
from contextlib import AsyncExitStack
from dataclasses import dataclass, field
from hashlib import sha1
from typing import TYPE_CHECKING, Any, Mapping

from langchain_core.tools import BaseTool

from ptc_agent.agent.middleware.direct_mcp import METADATA_KEY
from src.config.env import EGRESS_RELAY_LOOPBACK_URL, EGRESS_RELAY_SECRET
from src.server.database.mcp_oauth import SERVABLE, get_connection
from src.server.services.brokerage_capabilities import denied_tools, vendor_for_url
from src.server.services.egress import folded_contains
from src.server.services.egress.relay_jwt import CALLER_HOST, mint_relay_jwt
from src.server.services.mcp_tool_split import DirectServerTools

if TYPE_CHECKING:
    from ptc_agent.core.session import Session

logger = logging.getLogger(__name__)

_NAME_SAFE = re.compile(r"[^A-Za-z0-9_-]")
# The strictest provider limit on a tool name.
_MAX_TOOL_NAME = 64

# The sandbox_id claim on a host-only turn. Audit-only at the relay, which
# authorizes on the (user, workspace) pair, but the claim must be non-empty.
FLASH_SANDBOX_ID = "flash"


def direct_tool_name(server: str, tool: str) -> str:
    """``mcp__<server>__<tool>``: distinct per server so two vendors' ``account_*``
    tools cannot collide, and prefixed so the frontend can route on it.

    The plain form is kept only while it is unambiguous. A segment the provider
    would reject, a server name carrying the ``__`` separator, or an overflow of
    the limit each fall back to a digest of the *pair*, because two tools bound
    under one name are not merely mislabelled: the tools node keeps whichever
    came last, and ``DirectMcpPolicyMiddleware`` then gates the call against the
    other tool's connection.

    Over the limit it is the *server* that gives way, never the tool: a long
    server name would otherwise eat the whole budget and leave ``read_order``
    and ``cancel_order`` the same name. Only a tool long enough to overrun on
    its own is trimmed, and the digest sits ahead of the cut so identity
    survives it.
    """
    safe_server = _NAME_SAFE.sub("_", server).replace("__", "_")
    safe_tool = _NAME_SAFE.sub("_", tool)
    plain = f"mcp__{safe_server}__{safe_tool}"
    if plain == f"mcp__{server}__{tool}" and len(plain) <= _MAX_TOOL_NAME:
        return plain
    digest = sha1(f"{server}\x00{tool}".encode()).hexdigest()[:8]
    tail = f"_{digest}__{safe_tool}"
    keep = _MAX_TOOL_NAME - len("mcp__") - len(tail)
    if keep >= 1:
        return f"mcp__{safe_server[:keep]}{tail}"
    return f"mcp__{safe_server[:1]}_{digest}__{safe_tool}"[:_MAX_TOOL_NAME]


@dataclass
class DirectMCPBinding:
    """The tools bound for one turn, the clients behind them, and the policy.

    ``check`` is the port ``DirectMcpPolicyMiddleware`` calls per tool call. It
    reads the connection row again rather than the set bound at turn start:
    consent withdrawn on the Plugins page mid-turn, or a connection that went
    to ``needs_reauth``, refuses the next call instead of the next turn.
    """

    user_id: str | None = None
    tools: list[BaseTool] = field(default_factory=list)
    _clients: list[tuple[str, Any]] = field(default_factory=list)

    def add_server(self, name: str, client: Any) -> None:
        self._clients.append((name, client))

    async def check(self, server: str, tool: str) -> str | None:
        if not self.user_id:
            return "no user is attached to this turn"
        connection = await get_connection(self.user_id, server)
        if connection is None:
            return f"{server} is no longer connected"
        if connection.status not in SERVABLE:
            return f"{server} needs to be reconnected before it can be used"
        vendor = vendor_for_url(connection.server_url)
        denied = denied_tools(vendor, connection.granted_capabilities or ())
        if denied and folded_contains(denied, tool):
            return f"the connection to {server} does not permit {tool}"
        return None

    async def drive(self, stream: AsyncIterator[Any]) -> AsyncIterator[Any]:
        """Run ``stream`` with every relay session open around it.

        A server whose session cannot be opened is left closed with a warning
        rather than failing the turn: its tools then open a session per call,
        or fail per call with the same reason, and the rest of the toolset is
        unaffected.
        """
        if not self._clients:
            async for event in stream:
                yield event
            return
        async with AsyncExitStack() as stack:
            for server, client in self._clients:
                try:
                    await stack.enter_async_context(client)
                except Exception as e:
                    logger.warning(
                        "[DIRECT_MCP] %r: relay session failed to open: %s", server, e
                    )
            async for event in stream:
                yield event


async def prepare_direct_mcp_tools(
    *,
    user_id: str | None,
    workspace_id: str,
    sandbox_id: str,
    grants: Mapping[str, str],
    by_server: Mapping[str, DirectServerTools],
) -> DirectMCPBinding:
    """Build the tools for one turn; nothing is dialled until ``drive``."""
    binding = DirectMCPBinding(user_id=user_id)
    if not by_server or not grants or not EGRESS_RELAY_SECRET or not user_id:
        return binding

    from fastmcp import Client
    from fastmcp.client.transports import StreamableHttpTransport
    from mcp.types import Tool

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        from langchain.mcp import as_langchain_tool

    minted = mint_relay_jwt(
        EGRESS_RELAY_SECRET,
        user_id=user_id,
        workspace_id=workspace_id,
        sandbox_id=sandbox_id,
        caller=CALLER_HOST,
    )
    base = EGRESS_RELAY_LOOPBACK_URL.rstrip("/")

    for server, entry in by_server.items():
        grant_id = grants.get(server)
        schemas = entry.schemas
        if not grant_id or not schemas:
            continue
        client = Client(
            StreamableHttpTransport(
                url=f"{base}/v1/egress/{grant_id}",
                headers={"Authorization": f"Bearer {minted.token}"},
            )
        )
        bound = 0
        for schema in schemas:
            try:
                tool = Tool(
                    name=schema["name"],
                    description=schema.get("description"),
                    input_schema=schema.get("input_schema") or {"type": "object"},
                )
                # No I/O for a client that is not entered: the session opens
                # in ``drive``.
                lc_tool = await as_langchain_tool(tool, client)
            except Exception as e:
                logger.warning(
                    "[DIRECT_MCP] %r/%r: could not bind: %s",
                    server,
                    schema.get("name"),
                    e,
                )
                continue
            lc_tool.name = direct_tool_name(server, tool.name)
            lc_tool.metadata = {
                **(lc_tool.metadata or {}),
                METADATA_KEY: {
                    "server": server,
                    "tool": tool.name,
                },
            }
            binding.tools.append(lc_tool)
            bound += 1
        if bound:
            binding.add_server(server, client)
            logger.info(
                "[DIRECT_MCP] %r: bound %d tool(s) through grant %s",
                server,
                bound,
                grant_id,
            )
    return binding


async def bind_direct_mcp_tools(
    session: "Session", *, user_id: str | None
) -> DirectMCPBinding:
    """The PTC shape: the session carries the split and the grants."""
    by_server = session.direct_mcp_tools
    egress = session.egress_binding
    if not by_server or egress is None:
        return DirectMCPBinding(user_id=user_id)
    return await prepare_direct_mcp_tools(
        user_id=user_id,
        workspace_id=session.conversation_id,
        sandbox_id=getattr(session.sandbox, "sandbox_id", None) or "",
        grants=egress.grants,
        by_server=by_server,
    )
