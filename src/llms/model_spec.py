"""A model resolved down to what building a client needs.

A manifest entry and a user-defined one carry the same facts in different
shapes, so they are normalized to one type here and ``LLM.__init__`` runs a
single body for both. Imports nothing from ``llm``: the config class arrives as
an argument, which is what keeps the dependency pointing one way.
"""

import copy
from dataclasses import dataclass, field
from typing import Any, Protocol

from .reasoning import REASONING_LEVELS, apply_reasoning_effort


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


#: What a custom entry inherits from a built-in whose name it takes. Routing --
#: model_id, provider, parameters -- is the entry's whole reason to exist and
#: never inherits. These say what the model honors, and a shadow is the same
#: model reached through the user's own key. ``context`` is here because it is
#: the only compaction declaration the manifest actually makes:
#: ``compaction_profile_for`` reads the named profile first and the window's
#: band second, and every manifest row answers by window.
SHADOW_INHERITED = (
    "reasoning_efforts",
    "reasoning_effort_default",
    "prompt_guidance",
    "compaction_profile",
    "context",
)


#: Where a level is written, per vendor. ``apply_reasoning_effort`` dispatches on
#: whichever of these the model already declares and has no default branch, so a
#: shadow that borrowed a ladder has to borrow the surface too or the level it
#: resolves lands nowhere.
REASONING_SURFACE_KEYS = (
    "reasoning",
    "output_config",
    "thinking",
    "thinking_level",
    "reasoning_effort",
)


def _surface_of(declared: dict | None) -> dict:
    """Just the reasoning keys out of a model's parameters or extra_body."""
    return {k: v for k, v in (declared or {}).items() if k in REASONING_SURFACE_KEYS}


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
        efforts = canonical_reasoning_efforts(info.get("reasoning_efforts"))
        return cls(
            name=model_name,
            model_id=info["model_id"],
            provider=info["provider"],
            parameters=copy.deepcopy(info.get("parameters") or {}),
            extra_body=copy.deepcopy(info.get("extra_body") or {}),
            additional_betas=tuple(info.get("additional_betas") or ()),
            reasoning_efforts=efforts,
            reasoning_effort_default=default_reasoning_effort(
                efforts, info.get("reasoning_effort_default")
            ),
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
        efforts = canonical_reasoning_efforts(declared.get("reasoning_efforts"))
        declared_response_api = config.get("_use_response_api")
        own_params = config.get("parameters") or {}
        own_extra = config.get("extra_body") or {}
        # All or nothing, and across both containers, because one model can
        # spell its control in either: an entry naming any reasoning key owns
        # the surface, and filling in the vendors it left out would put a
        # second, never-written control on the wire beside the one it declared.
        # Gated on the ladder too -- an entry declaring no levels wants no
        # reasoning key at all, not the shadowed model's default.
        inherits_surface = (
            bool(efforts)
            and shadowed is not None
            and not any(k in own_params or k in own_extra for k in REASONING_SURFACE_KEYS)
        )
        # Deep-copied before anything writes to them: the borrowed surface shares
        # its nested dicts with the process-wide manifest.
        parameters = copy.deepcopy(
            {**own_params, **_surface_of(shadowed.get("parameters"))} if inherits_surface else own_params
        )
        extra_body = copy.deepcopy(
            {**own_extra, **_surface_of(shadowed.get("extra_body"))} if inherits_surface else own_extra
        )
        default = default_reasoning_effort(efforts, declared.get("reasoning_effort_default"))
        if inherits_surface and default:
            # A borrowed surface carries the built-in's level, which is not this
            # entry's answer: an entry may narrow the ladder or name its own
            # default. Writing the resolved default into it keeps what a call
            # with no request reports and what the wire carries from disagreeing,
            # which is the invariant every manifest row already satisfies. Only
            # for a surface we seeded; a level the entry typed itself is its own.
            apply_reasoning_effort(default, parameters, extra_body)
        return cls(
            name=config.get("name", config["model_id"]),
            model_id=config["model_id"],
            provider=config["provider"],
            parameters=parameters,
            extra_body=extra_body,
            additional_betas=tuple(config.get("additional_betas") or ()),
            reasoning_efforts=efforts,
            reasoning_effort_default=default,
            sdk_fallback="openai",
            use_response_api_override=(
                None if declared_response_api is None else bool(declared_response_api)
            ),
        )
