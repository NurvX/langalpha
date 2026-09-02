"""A model resolved down to what building a client needs.

A manifest entry and a user-defined one carry the same facts in different
shapes, so they are normalized to one type here and ``LLM.__init__`` runs a
single body for both. Imports nothing from ``llm``: the config class arrives as
an argument, which is what keeps the dependency pointing one way.
"""

import copy
from dataclasses import dataclass, field
from typing import Any, Protocol

from .reasoning import REASONING_LEVELS, infer_surface, validate_surface


class ManifestSource(Protocol):
    """The single lookup :meth:`ModelSpec.from_manifest` needs from the config."""

    def get_model_config(self, model_id: str) -> dict | None: ...


def canonical_reasoning_efforts(declared: Any) -> tuple[str, ...]:
    """Declared reasoning levels, deduped and in canonical order.

    Anything outside :data:`REASONING_LEVELS` is dropped, so a typo in a
    manifest entry or a user-defined model costs one button instead of offering
    a level the provider will reject.
    """
    if not isinstance(declared, list):
        return ()
    seen = {v for v in declared if v in REASONING_LEVELS}
    return tuple(level for level in REASONING_LEVELS if level in seen)


def default_reasoning_effort(
    efforts: tuple[str, ...] | list[str], declared: Any
) -> str | None:
    """The level used when the user has not chosen one.

    Falls back to the middle of the model's own range rather than a fixed name,
    because "medium" is not in every model's vocabulary: a binary model's two
    levels are off and on.
    """
    if not efforts:
        return None
    if declared in efforts:
        return declared
    return efforts[len(efforts) // 2]


def reasoning_block(entry: dict | None) -> dict:
    """One model's reasoning declaration, from either shape it may be stored in.

    The manifest states it as a single ``reasoning`` block. Custom models saved
    before that block existed carry the same facts as flat ``reasoning_efforts``
    / ``reasoning_effort_default`` keys, so both are read here rather than
    migrating a preferences column.
    """
    entry = entry or {}
    block = entry.get("reasoning")
    if isinstance(block, dict):
        return block
    flat = {}
    if "reasoning_efforts" in entry:
        flat["efforts"] = entry["reasoning_efforts"]
    if "reasoning_effort_default" in entry:
        flat["default"] = entry["reasoning_effort_default"]
    return flat


def clamp_reasoning_effort(
    efforts: tuple[str, ...] | list[str], default: str | None, requested: str
) -> str | None:
    """The level to actually send, or None to leave the model's own default.

    Takes the ladder rather than a model name because a user-defined model has
    no manifest row to look one up in. An unhonored level steps *down* to the
    nearest one the ladder offers, so the request is never overshot; below its
    floor there is nowhere to step but the lowest level, and a level outside
    the vocabulary takes the default.
    """
    if not efforts:
        return None
    if requested in efforts:
        return requested
    if requested not in REASONING_LEVELS:
        return default
    ceiling = REASONING_LEVELS.index(requested)
    at_or_below = [e for e in efforts if REASONING_LEVELS.index(e) <= ceiling]
    return at_or_below[-1] if at_or_below else efforts[0]


#: The keys of a ``reasoning`` block that say where a level is written, as
#: opposed to which levels exist.
SURFACE_KEYS = ("write", "on", "off")


def _checked_surface(name: str, reasoning: dict | None) -> dict:
    """Just the write half of a ``reasoning`` block, validated.

    Raises rather than dropping the bad path, so a typo is a loud error naming
    the model instead of a silent no-op on the wire. Spec-building is per
    request, so for manifest rows the suite is what catches one first:
    ``test_reasoning_efforts_manifest`` builds every entry.
    """
    if not reasoning:
        return {}
    validate_surface(name, reasoning)
    return {k: reasoning[k] for k in SURFACE_KEYS if k in reasoning}


#: What a custom entry inherits from a built-in whose name it takes. Routing --
#: model_id, provider, parameters -- is the entry's whole reason to exist and
#: never inherits. These say what the model honors, and a shadow is the same
#: model reached through the user's own key. ``context`` is here because it is
#: the only compaction declaration the manifest actually makes:
#: ``compaction_profile_for`` reads the named profile first and the window's
#: band second, and every manifest row answers by window. ``reasoning`` is
#: inherited whole: a borrowed ladder needs somewhere to be written, and an
#: entry taking the levels but not the write path would resolve a level that
#: lands nowhere.
SHADOW_INHERITED = (
    "reasoning",
    "prompt_guidance",
    "compaction_profile",
    "context",
)


def with_inherited_declarations(entry: dict, shadowed: dict | None) -> dict:
    """A custom entry filled in from the built-in whose name it took.

    Presence, not truthiness: an entry declaring ``reasoning_efforts: []`` is
    saying the model honors no levels, and the shadowed ladder must not
    overwrite that answer.
    """
    if not shadowed:
        return entry
    inherited = {k: shadowed[k] for k in SHADOW_INHERITED if k not in entry and k in shadowed}
    return {**entry, **inherited} if inherited else entry


@dataclass(frozen=True)
class ModelSpec:
    """One model's client-building facts, whatever declared them."""

    name: str
    model_id: str
    provider: str
    parameters: dict[str, Any] = field(default_factory=dict)
    extra_body: dict[str, Any] = field(default_factory=dict)
    additional_betas: tuple[str, ...] = ()
    reasoning_efforts: tuple[str, ...] = ()
    reasoning_effort_default: str | None = None
    #: Where this model's effort level is written. Empty means no effort control.
    reasoning_surface: dict[str, Any] = field(default_factory=dict)
    #: Platform proxy to route through when the caller brings no key of its own.
    system_provider: str | None = None
    #: SDK to assume when the provider is not in the manifest at all. A manifest
    #: model has no such guess to make; a custom endpoint is usually
    #: OpenAI-compatible.
    sdk_fallback: str | None = None
    #: Response-API opt-in the entry states outright, overriding the provider's.
    use_response_api_override: bool | None = None

    @classmethod
    def from_manifest(cls, model_config: ManifestSource, model_name: str) -> "ModelSpec":
        info = model_config.get_model_config(model_name)
        if not info:
            raise ValueError(f"Model {model_name} not found in models.json")
        reasoning = reasoning_block(info)
        efforts = canonical_reasoning_efforts(reasoning.get("efforts"))
        return cls(
            name=model_name,
            model_id=info["model_id"],
            provider=info["provider"],
            parameters=copy.deepcopy(info.get("parameters") or {}),
            extra_body=copy.deepcopy(info.get("extra_body") or {}),
            additional_betas=tuple(info.get("additional_betas") or ()),
            reasoning_efforts=efforts,
            reasoning_effort_default=default_reasoning_effort(
                efforts, reasoning.get("default")
            ),
            reasoning_surface=_checked_surface(model_name, reasoning),
            system_provider=info.get("system_provider"),
        )

    @classmethod
    def from_custom(cls, config: dict, shadowed: dict | None = None) -> "ModelSpec":
        """A user-defined entry, which carries its own model_id and ladder.

        ``shadowed`` is the manifest row whose name this entry took, when it
        took one. The entry still routes the call, but a level it does not list
        itself is the built-in's to declare.
        """
        declared = with_inherited_declarations(config, shadowed)
        reasoning = reasoning_block(declared)
        efforts = canonical_reasoning_efforts(reasoning.get("efforts"))
        declared_response_api = config.get("_use_response_api")
        # Deep-copied because the borrowed block shares its nested dicts with
        # the process-wide manifest, and the mapper writes into these.
        parameters = copy.deepcopy(config.get("parameters") or {})
        extra_body = copy.deepcopy(config.get("extra_body") or {})
        # Gated on the ladder: an entry declaring no levels wants no effort
        # control at all, not the shadowed model's surface. Inference is the
        # last resort, for a standalone entry that predates the block.
        surface = reasoning if efforts else None
        if efforts and not any(k in reasoning for k in SURFACE_KEYS):
            surface = infer_surface(parameters, extra_body)
        default = default_reasoning_effort(efforts, reasoning.get("default"))
        return cls(
            name=config.get("name", config["model_id"]),
            model_id=config["model_id"],
            provider=config["provider"],
            parameters=parameters,
            extra_body=extra_body,
            additional_betas=tuple(config.get("additional_betas") or ()),
            reasoning_efforts=efforts,
            reasoning_effort_default=default,
            reasoning_surface=_checked_surface(
                config.get("name", config["model_id"]), surface
            ),
            sdk_fallback="openai",
            use_response_api_override=(
                None if declared_response_api is None else bool(declared_response_api)
            ),
        )
