"""What a turn knows about itself, carried whole from the request to the stack.

These four values are read off the request that opened the turn and are used in
exactly one place, the turn anchor row. Threading them one by one made every
builder between the handler and the middleware restate a list it has no other
interest in, and adding a fifth meant editing five signatures.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime


@dataclass(frozen=True, slots=True)
class TurnContext:
    """Per-turn runtime context for the turn anchor row. Every field is optional.

    A context-free build (thread maintenance, a subagent stack, a test) passes
    no context at all, which is the same thing as passing one whose fields are
    all None: the row states the market unconditionally and drops the gap line.
    """

    last_turn_at: datetime | None = None
    platform: str | None = None
    origin: str | None = None
    surface_rules: str | None = None
