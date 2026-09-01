"""Unified reasoning effort mapper.

Translates a level the manifest has **already guaranteed** the model accepts
into that provider's native parameter. Detection-based: the shape of the model's
``parameters``/``extra_body`` says which surface it speaks, so adding a model
never means editing a list in here.

Nothing is clamped here. A level outside the model's declared
``reasoning_efforts`` is resolved upstream by ``clamp_reasoning_effort`` in
``llm.py``, the only place that can see the enum, which steps down to the
nearest level the model does offer. By the time a request reaches this function
the level is known-good, so a lossy fallback here would only hide a bug.
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

# Anthropic-compatible endpoints take a token budget rather than a level name.
_ANTHROPIC_BUDGETS = {
    "minimal": 2000,
    "low": 5000,
    "medium": 10000,
    "high": 32000,
    "xhigh": 64000,
    "max": 128000,
}


def _budget(table: dict[str, int], level: str) -> int:
    """Nearest declared budget at or below ``level``.

    A model may declare a level this ladder has no rung for; walking down the
    canonical order is still honest, because the level came from that model's
    own enum and the ladder only decides how many tokens to spend.
    """
    if level in table:
        return table[level]
    idx = REASONING_LEVELS.index(level)
    for candidate in reversed(REASONING_LEVELS[:idx]):
        if candidate in table:
            return table[candidate]
    return min(table.values())


def _switch_off(container: dict) -> bool:
    """Flip a declared ``thinking`` mode switch to off; report whether there was one.

    The graded effort key is deliberately left at its declared value. ``none`` is
    not universally accepted as an effort — DeepSeek rejects it with a 400, and
    GLM keeps on thinking through it — so on a surface carrying both a switch and
    a dial, only the switch reliably means off.
    """
    declared = container.get("thinking")
    if not isinstance(declared, dict):
        return False
    # Bare, not merged: Anthropic's `thinking` is a discriminated union, and the
    # disabled variant rejects the `budget_tokens` the enabled one requires.
    # Siblings only ever describe reasoning output, which off does not produce.
    container["thinking"] = {"type": "disabled"}
    return True


def apply_reasoning_effort(
    level: str,
    parameters: dict,
    extra_body: dict,
) -> tuple[dict, dict]:
    """Apply a reasoning effort level to a model's request parameters.

    Args:
        level: A level from :data:`REASONING_LEVELS`, already validated against
            the model's declared ``reasoning_efforts``.
        parameters: Model parameters dict (mutated in place).
        extra_body: Extra body dict (mutated in place).

    Returns:
        Tuple of (parameters, extra_body) — the same objects, mutated.
    """
    if level not in REASONING_LEVELS:
        return parameters, extra_body

    off = level in OFF_LEVELS

    # --- parameters-based surfaces ---

    # OpenAI: parameters.reasoning.effort
    if "reasoning" in parameters:
        if isinstance(parameters["reasoning"], dict):
            parameters["reasoning"]["effort"] = level
        else:
            parameters["reasoning"] = {"effort": level}

    # Anthropic graded: output_config.effort carries the level natively. Declaring
    # it is what marks the surface as graded — a model whose only control is a
    # `thinking` switch falls through to the mode-switch branch below.
    elif "output_config" in parameters:
        if not (off and _switch_off(parameters)):
            parameters.setdefault("output_config", {})["effort"] = level

    # Anthropic-compatible `thinking`: a budget dial, unless the declared type is
    # `adaptive` (MiniMax), which is a bare on/off switch the vendor sizes itself.
    elif "thinking" in parameters:
        declared = (
            parameters["thinking"] if isinstance(parameters["thinking"], dict) else {}
        )
        if off:
            parameters["thinking"] = {"type": "disabled"}
        elif declared.get("type") != "adaptive":
            parameters["thinking"] = {
                **declared,
                "type": "enabled",
                "budget_tokens": _budget(_ANTHROPIC_BUDGETS, level),
            }

    # Gemini 3.x: parameters.thinking_level
    elif "thinking_level" in parameters:
        parameters["thinking_level"] = level

    # vLLM / Groq / Cerebras: parameters.reasoning_effort
    elif "reasoning_effort" in parameters:
        parameters["reasoning_effort"] = level

    # --- extra_body surfaces ---
    #
    # Chained, not independent `if`s. glm-5.2 declares both `thinking.type` and
    # `reasoning_effort`; when both fired, one of the two keys was dead weight.
    # `reasoning_effort` is the graded control, so it wins for every thinking
    # level — but not for off, which it does not honor (`reasoning_effort:
    # "none"` still returned ~165 reasoning tokens; the switch returned zero).

    # Zhipu / Z.ai GLM: extra_body.reasoning_effort, native level names.
    if "reasoning_effort" in extra_body:
        if not (off and _switch_off(extra_body)):
            extra_body["reasoning_effort"] = level

    # Dashscope / Qwen: extra_body.reasoning.effort, native level names.
    # Same seven levels as our canonical vocabulary, `none` included, so the
    # level goes out verbatim. Nested rather than flat, which is the only thing
    # separating this from the GLM surface above.
    elif "reasoning" in extra_body:
        if isinstance(extra_body["reasoning"], dict):
            extra_body["reasoning"]["effort"] = level
        else:
            extra_body["reasoning"] = {"effort": level}

    # extra_body.thinking.type is a mode switch, not a dial. The on-value comes
    # from the manifest rather than a constant: vendors spell it differently
    # (`enabled` on GLM, `adaptive` on MiniMax) and a hardcoded one is silently
    # wrong on the other.
    elif "thinking" in extra_body:
        declared = (
            extra_body["thinking"] if isinstance(extra_body["thinking"], dict) else {}
        )
        # A declared `disabled` is a seed meaning "off unless asked", not a
        # usable on-value, so it falls back rather than pinning thinking off.
        declared_type = declared.get("type")
        on_value = (
            declared_type if declared_type not in (None, "disabled") else "enabled"
        )
        extra_body["thinking"] = (
            {"type": "disabled"} if off else {**declared, "type": on_value}
        )

    return parameters, extra_body
