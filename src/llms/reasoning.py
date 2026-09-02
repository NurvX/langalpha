"""Unified reasoning effort mapper.

Translates a level the manifest has **already guaranteed** the model accepts into
that provider's native parameter. Each entry names its own surface in a
``reasoning_surface`` block, so the mapping is a declaration rather than a guess
about which key the entry happened to carry.

Nothing is clamped here. A level outside the model's declared
``reasoning_efforts`` is resolved upstream by ``clamp_reasoning_effort`` in
``llm.py``, the only place that can see the enum, which steps down to the nearest
level the model does offer. By the time a request reaches this function the level
is known-good, so a lossy fallback here would only hide a bug.
"""

from typing import Literal, get_args

#: Canonical ordered vocabulary. Ordering is meaningful: the UI renders the
#: model's declared subset in this order, and it matches langchain's upstream
#: ``ModelProfile`` levels so the two stay comparable.
#:
#: Declared as a ``Literal`` first so the request models can annotate against the
#: same vocabulary rather than restating it. A hand-copied list drifted once
#: already: the API rejected ``none``/``minimal``/``max`` for every model whose
#: manifest entry offered them, including ones whose own default was ``max``.
ReasoningLevel = Literal["none", "minimal", "low", "medium", "high", "xhigh", "max"]

REASONING_LEVELS: tuple[ReasoningLevel, ...] = get_args(ReasoningLevel)

#: Levels that mean "do not think". Every binary surface keys off this rather
#: than off ``low``, which is a real thinking level everywhere that grades.
OFF_LEVELS = frozenset({"none"})

#: Paths a ``write`` may target: graded dials that take a level name verbatim.
#: Closed on purpose. A dotted string makes a typo look structurally valid, and
#: a write to a misspelled path lands somewhere the vendor ignores and returns
#: 200 for, which is the exact silent failure this block exists to remove.
WRITE_PATHS = frozenset(
    {
        "parameters.reasoning.effort",
        "parameters.output_config.effort",
        "parameters.reasoning_effort",
        "parameters.thinking_level",
        "extra_body.reasoning_effort",
    }
)

#: Paths an ``on``/``off`` patch may target. Wider than :data:`WRITE_PATHS`
#: because a patch also flips mode switches, and narrower in intent: a patch
#: carries a literal from the manifest, never the level.
PATCH_PATHS = frozenset(
    {
        "parameters.output_config.effort",
        "parameters.thinking.type",
        "extra_body.reasoning_effort",
        "extra_body.thinking.type",
        "extra_body.thinking.clear_thinking",
    }
)


class ReasoningSurfaceError(ValueError):
    """A ``reasoning`` block names a path outside the allowlists."""


def validate_surface(name: str, surface: dict) -> None:
    """Reject an unknown path at load time, where the manifest author sees it."""
    write = surface.get("write")
    if write is not None and write not in WRITE_PATHS:
        raise ReasoningSurfaceError(
            f"{name}: reasoning.write={write!r} is not a known write path"
        )
    for key in ("on", "off"):
        for path in surface.get(key) or {}:
            if path not in PATCH_PATHS:
                raise ReasoningSurfaceError(
                    f"{name}: reasoning.{key} path {path!r} is not a known patch path"
                )
    if write is None and not (surface.get("on") or surface.get("off")):
        raise ReasoningSurfaceError(
            f"{name}: reasoning declares efforts with nowhere to write them"
        )


def infer_surface(parameters: dict | None, extra_body: dict | None) -> dict:
    """Guess the surface of a user-supplied entry that declared none.

    Only for BYOK entries. A manifest row states its surface outright; a user
    pasting an OpenAI-compatible config cannot be asked to name a write path, and
    entries stored before the block existed carry only the seed. Graded dials
    only — a mode switch or a token budget has to be declared, because there is
    no seed value that distinguishes one from a dial's starting point.
    """
    lanes = {"parameters": parameters or {}, "extra_body": extra_body or {}}
    for path in sorted(WRITE_PATHS):
        lane, *rest = path.split(".")
        node = lanes[lane]
        for segment in rest[:-1]:
            node = node.get(segment) if isinstance(node, dict) else None
        if isinstance(node, dict) and rest[-1] in node:
            return {"write": path}
    return {}


def _put(lanes: dict[str, dict], path: str, value) -> None:
    lane, *rest = path.split(".")
    node = lanes[lane]
    for segment in rest[:-1]:
        child = node.get(segment)
        if not isinstance(child, dict):
            child = {}
            node[segment] = child
        node = child
    node[rest[-1]] = value


def apply_reasoning_effort(
    level: str,
    parameters: dict,
    extra_body: dict,
    surface: dict | None = None,
) -> tuple[dict, dict]:
    """Apply a reasoning effort level to a model's request parameters.

    ``off`` replaces the graded write rather than layering over it: on a surface
    carrying both a switch and a dial, only the switch reliably means off, and
    the two would otherwise contradict each other in the same payload.

    Args:
        level: A level from :data:`REASONING_LEVELS`, already validated against
            the model's declared ``reasoning_efforts``.
        parameters: Model parameters dict (mutated in place).
        extra_body: Extra body dict (mutated in place).
        surface: The model's ``reasoning_surface`` block. Absent means the model
            offers no effort control, and nothing is written.

    Returns:
        Tuple of (parameters, extra_body) — the same objects, mutated.
    """
    if not surface or level not in REASONING_LEVELS:
        return parameters, extra_body

    lanes = {"parameters": parameters, "extra_body": extra_body}
    off_patch = surface.get("off")

    if level in OFF_LEVELS and off_patch:
        # `off` states the whole reasoning payload rather than layering over
        # what is there: a mode switch sits in a discriminated union whose
        # disabled variant rejects the siblings the enabled one requires, so a
        # caller-supplied `budget_tokens` must not survive next to it. Cleared
        # in its own pass first, or two paths sharing a container would wipe
        # each other's write.
        for path in off_patch:
            lane, *rest = path.split(".")
            if len(rest) > 1:
                lanes[lane][rest[0]] = {}
        for path, value in off_patch.items():
            _put(lanes, path, value)
        return parameters, extra_body

    for path, value in (surface.get("on") or {}).items():
        _put(lanes, path, value)
    if write := surface.get("write"):
        _put(lanes, write, level)

    return parameters, extra_body
