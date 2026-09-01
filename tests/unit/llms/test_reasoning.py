"""
Tests for src.llms.reasoning — apply_reasoning_effort() multi-provider mapper.

Covers all provider detection patterns:
- OpenAI: parameters.reasoning.effort
- Anthropic graded: output_config.effort (declared output_config key)
- Anthropic enabled: thinking.budget_tokens
- Anthropic adaptive (bare): thinking.type as an on/off switch
- Gemini 3.x: thinking_level
- vLLM/Groq/Cerebras: reasoning_effort
- Binary switch: extra_body.thinking.type
- Dashscope/Qwen: extra_body.reasoning.effort
- Combined extra_body patterns (always run regardless of parameters branch)
- Invalid level passthrough
"""

import copy

import pytest

from src.llms.reasoning import (
    OFF_LEVELS,
    REASONING_LEVELS,
    _ANTHROPIC_BUDGETS,
    _budget,
    apply_reasoning_effort,
)


# ---------------------------------------------------------------------------
# Invalid / passthrough
# ---------------------------------------------------------------------------


class TestReasoningInvalidLevel:
    def test_invalid_level_returns_unchanged(self):
        params = {"reasoning": {"effort": "medium"}}
        extra = {}
        result_params, result_extra = apply_reasoning_effort("invalid", params, extra)
        assert result_params["reasoning"]["effort"] == "medium"  # Unchanged

    def test_empty_string_returns_unchanged(self):
        params = {"reasoning": {"effort": "medium"}}
        extra = {}
        apply_reasoning_effort("", params, extra)
        assert params["reasoning"]["effort"] == "medium"

    def test_constants(self):
        assert REASONING_LEVELS == (
            "none",
            "minimal",
            "low",
            "medium",
            "high",
            "xhigh",
            "max",
        )
        assert "low" in _ANTHROPIC_BUDGETS

    def test_levels_are_ordered_weakest_first(self):
        """The UI renders a model's declared subset in this order, and the
        budget ladders walk down it — an unordered tuple would silently pick
        the wrong rung."""
        assert REASONING_LEVELS.index("none") < REASONING_LEVELS.index("low")
        assert REASONING_LEVELS.index("low") < REASONING_LEVELS.index("high")
        assert REASONING_LEVELS.index("high") < REASONING_LEVELS.index("max")

    def test_only_none_means_off(self):
        """`low` is a real thinking level on every surface that grades. Binary
        surfaces used to key off it, which is why three of four buttons emitted
        an identical request."""
        assert OFF_LEVELS == frozenset({"none"})


# ---------------------------------------------------------------------------
# OpenAI: parameters.reasoning.effort
# ---------------------------------------------------------------------------


class TestOpenAIReasoning:
    @pytest.mark.parametrize("level", ["low", "medium", "high"])
    def test_sets_effort(self, level):
        params = {"reasoning": {"effort": "medium", "summary": "auto"}}
        extra = {}
        apply_reasoning_effort(level, params, extra)
        assert params["reasoning"]["effort"] == level
        assert params["reasoning"]["summary"] == "auto"  # Other keys preserved

    def test_non_dict_reasoning_replaced(self):
        """If reasoning is not a dict, replace with dict containing effort."""
        params = {"reasoning": True}
        extra = {}
        apply_reasoning_effort("high", params, extra)
        assert params["reasoning"] == {"effort": "high"}


# ---------------------------------------------------------------------------
# Anthropic adaptive: output_config.effort
# ---------------------------------------------------------------------------


class TestAnthropicAdaptive:
    def test_output_config_present(self):
        """When output_config key exists, sets effort on it."""
        params = {"output_config": {"effort": "medium"}}
        extra = {}
        apply_reasoning_effort("high", params, extra)
        assert params["output_config"]["effort"] == "high"

    def test_bare_adaptive_is_a_switch_not_the_graded_surface(self):
        """Declaring `output_config` is what marks a surface graded. MiniMax
        spells its on/off switch `adaptive` too but has no `output_config`, and
        inferring one from the word alone sent it a field it does not accept."""
        params = {"thinking": {"type": "adaptive"}}
        extra = {}
        apply_reasoning_effort("low", params, extra)
        assert "output_config" not in params
        assert params["thinking"] == {"type": "adaptive"}

    @pytest.mark.parametrize("level", ["low", "medium", "high", "xhigh"])
    def test_all_levels(self, level):
        params = {
            "thinking": {"type": "adaptive"},
            "output_config": {"effort": "medium"},
        }
        extra = {}
        apply_reasoning_effort(level, params, extra)
        assert params["output_config"]["effort"] == level

    def test_off_rides_the_switch_and_leaves_the_effort_alone(self):
        """DeepSeek 400s on `output_config.effort: "none"` — its accepted set is
        low..max with no off rung — while `thinking.type: "disabled"` returns
        zero reasoning. So off is the switch, and the effort keeps its value."""
        params = {
            "thinking": {"type": "enabled"},
            "output_config": {"effort": "medium"},
        }
        apply_reasoning_effort("none", params, {})
        assert params["thinking"] == {"type": "disabled"}
        assert params["output_config"] == {"effort": "medium"}

    def test_xhigh_passes_through(self):
        """Anthropic adaptive natively supports xhigh — must pass through, not clamp."""
        params = {"thinking": {"type": "adaptive"}, "output_config": {"effort": "high"}}
        extra = {}
        apply_reasoning_effort("xhigh", params, extra)
        assert params["output_config"]["effort"] == "xhigh"


# ---------------------------------------------------------------------------
# Anthropic enabled: thinking.budget_tokens
# ---------------------------------------------------------------------------


class TestAnthropicEnabled:
    @pytest.mark.parametrize("level", ["low", "medium", "high"])
    def test_sets_budget_tokens(self, level):
        params = {"thinking": {"type": "enabled", "budget_tokens": 10000}}
        extra = {}
        apply_reasoning_effort(level, params, extra)
        assert params["thinking"]["budget_tokens"] == _ANTHROPIC_BUDGETS[level]

    def test_non_dict_thinking_replaced(self):
        params = {"thinking": True}
        extra = {}
        apply_reasoning_effort("medium", params, extra)
        assert params["thinking"]["type"] == "enabled"
        assert params["thinking"]["budget_tokens"] == _ANTHROPIC_BUDGETS["medium"]


# ---------------------------------------------------------------------------
# Gemini 3.x: thinking_level
# ---------------------------------------------------------------------------


class TestGemini3xThinkingLevel:
    @pytest.mark.parametrize("level", ["low", "medium", "high"])
    def test_sets_level(self, level):
        params = {"thinking_level": "medium"}
        extra = {}
        apply_reasoning_effort(level, params, extra)
        assert params["thinking_level"] == level


# ---------------------------------------------------------------------------
# vLLM / Groq / Cerebras: reasoning_effort
# ---------------------------------------------------------------------------


class TestVLLMReasoningEffort:
    @pytest.mark.parametrize("level", ["low", "medium", "high"])
    def test_sets_effort(self, level):
        params = {"reasoning_effort": "medium"}
        extra = {}
        apply_reasoning_effort(level, params, extra)
        assert params["reasoning_effort"] == level


# ---------------------------------------------------------------------------
# Binary mode switch: extra_body.thinking.type
# ---------------------------------------------------------------------------


class TestBinaryThinkingSwitch:
    """A switch, not a dial — the only honest offer is off/on. The on-value is
    whatever the manifest declared, because vendors spell it differently."""

    def test_declared_on_value_is_preserved(self):
        params = {}
        extra = {"thinking": {"type": "adaptive"}}
        apply_reasoning_effort("high", params, extra)
        assert extra["thinking"]["type"] == "adaptive"

    def test_sibling_keys_survive_while_on(self):
        params = {}
        extra = {"thinking": {"type": "enabled", "clear_thinking": False}}
        apply_reasoning_effort("high", params, extra)
        assert extra["thinking"] == {"type": "enabled", "clear_thinking": False}

    def test_off_is_the_bare_disabled_shape(self):
        """Anthropic's `thinking` is a discriminated union whose disabled variant
        rejects `budget_tokens`, so off emits the bare shape rather than merging
        over the on-state. Siblings only describe reasoning output there is none of."""
        params = {}
        extra = {"thinking": {"type": "enabled", "clear_thinking": False}}
        apply_reasoning_effort("none", params, extra)
        assert extra["thinking"] == {"type": "disabled"}

    def test_none_disables(self):
        params = {}
        extra = {"thinking": {"type": "enabled"}}
        apply_reasoning_effort("none", params, extra)
        assert extra["thinking"]["type"] == "disabled"

    @pytest.mark.parametrize("level", ["low", "medium", "high", "max"])
    def test_every_other_level_enables(self, level):
        params = {}
        extra = {"thinking": {"type": "disabled"}}
        apply_reasoning_effort(level, params, extra)
        assert extra["thinking"]["type"] == "enabled"

    def test_non_dict_thinking(self):
        params = {}
        extra = {"thinking": True}
        apply_reasoning_effort("none", params, extra)
        assert extra["thinking"]["type"] == "disabled"


# ---------------------------------------------------------------------------
# Dashscope / Qwen: extra_body.reasoning.effort
# ---------------------------------------------------------------------------


class TestDashscopeReasoningEffort:
    """Qwen publishes the same seven increasing levels as our canonical
    vocabulary, so the level goes out verbatim. It replaced `enable_thinking`,
    a binary switch that had been wearing a graded ladder built out of
    `thinking_budget` — a cap the vendor never documented as honored."""

    @pytest.mark.parametrize("level", REASONING_LEVELS)
    def test_every_level_passes_through_verbatim(self, level):
        params = {}
        extra = {"reasoning": {"effort": "xhigh"}}
        apply_reasoning_effort(level, params, extra)
        assert extra["reasoning"] == {"effort": level}

    def test_off_is_a_level_not_a_removal(self):
        """`none` is one of the seven the vendor accepts, so turning thinking
        off means sending it — never dropping the key, which would restore the
        `xhigh` default instead."""
        params = {}
        extra = {"reasoning": {"effort": "high"}}
        apply_reasoning_effort("none", params, extra)
        assert extra["reasoning"] == {"effort": "none"}

    def test_non_dict_reasoning(self):
        params = {}
        extra = {"reasoning": True}
        apply_reasoning_effort("medium", params, extra)
        assert extra["reasoning"] == {"effort": "medium"}

    def test_sibling_keys_survive(self):
        params = {}
        extra = {"reasoning": {"effort": "xhigh", "summary": "auto"}}
        apply_reasoning_effort("low", params, extra)
        assert extra["reasoning"] == {"effort": "low", "summary": "auto"}


# ---------------------------------------------------------------------------
# GLM 5.2+: extra_body.reasoning_effort
# ---------------------------------------------------------------------------


class TestGLMReasoningEffort:
    """Zhipu enumerated its own accepted set in a 400: none, minimal, low,
    medium, high, xhigh, max — the widest of any provider, and identical to our
    canonical vocabulary. So the level goes out verbatim."""

    @pytest.mark.parametrize("level", REASONING_LEVELS)
    def test_every_level_passes_through_verbatim(self, level):
        params = {}
        extra = {"reasoning_effort": "max"}
        apply_reasoning_effort(level, params, extra)
        assert extra["reasoning_effort"] == level

    def test_reasoning_effort_wins_over_thinking_type(self):
        """The real glm-5.2 entry declares both keys. They used to be
        independent `if`s, so both fired and which one Zhipu honors was never
        established. The graded control wins and the mode switch is left alone."""
        params = {"max_tokens": 128000}
        extra = {
            "thinking": {"type": "enabled", "clear_thinking": False},
            "reasoning_effort": "high",
        }
        apply_reasoning_effort("xhigh", params, extra)
        assert extra["reasoning_effort"] == "xhigh"
        assert extra["thinking"] == {"type": "enabled", "clear_thinking": False}

    def test_off_rides_the_switch_not_the_graded_key(self):
        """`reasoning_effort: "none"` is accepted but not honored — glm-5.2 still
        returned ~165 reasoning tokens through it, while `thinking.type:
        "disabled"` returned zero. So off is the switch, and the graded key
        keeps the value the manifest declared."""
        params = {}
        extra = {
            "thinking": {"type": "enabled", "clear_thinking": False},
            "reasoning_effort": "max",
        }
        apply_reasoning_effort("none", params, extra)
        assert extra["thinking"]["type"] == "disabled"
        assert extra["reasoning_effort"] == "max"


# ---------------------------------------------------------------------------
# Combined: extra_body patterns run INDEPENDENTLY of parameters branch
# ---------------------------------------------------------------------------


class TestCombinedPatterns:
    def test_openai_plus_binary_switch(self):
        """A parameters surface and an extra_body surface are independent axes
        and both still apply."""
        params = {"reasoning": {"effort": "medium"}}
        extra = {"thinking": {"type": "enabled"}}
        apply_reasoning_effort("none", params, extra)
        assert params["reasoning"]["effort"] == "none"
        assert extra["thinking"]["type"] == "disabled"

    def test_anthropic_plus_dashscope(self):
        params = {"thinking": {"type": "enabled", "budget_tokens": 10000}}
        extra = {"reasoning": {"effort": "xhigh"}}
        apply_reasoning_effort("low", params, extra)
        assert params["thinking"]["budget_tokens"] == _ANTHROPIC_BUDGETS["low"]
        assert extra["reasoning"]["effort"] == "low"

    def test_anthropic_budget_surface_can_be_turned_off(self):
        params = {"thinking": {"type": "enabled", "budget_tokens": 10000}}
        apply_reasoning_effort("none", params, {})
        assert params["thinking"] == {"type": "disabled"}

    def test_mutates_in_place(self):
        """apply_reasoning_effort should mutate and return the same objects."""
        params = {"reasoning": {"effort": "low"}}
        extra = {}
        result_params, result_extra = apply_reasoning_effort("high", params, extra)
        assert result_params is params
        assert result_extra is extra

    def test_no_matching_pattern_no_change(self):
        """If no pattern matches, parameters and extra_body stay unchanged."""
        params = {"temperature": 0.7, "max_tokens": 1000}
        extra = {"custom_field": True}
        original_params = copy.deepcopy(params)
        original_extra = copy.deepcopy(extra)
        apply_reasoning_effort("high", params, extra)
        assert params == original_params
        assert extra == original_extra


# ---------------------------------------------------------------------------
# Nothing is clamped — the manifest decides what a model is offered
# ---------------------------------------------------------------------------


class TestNothingIsClamped:
    """The mapper used to silently drop `xhigh` to `high` on five surfaces, so
    a user picking the top level got the one below it with no signal. A level
    can no longer arrive unless the model's own enum listed it, which makes a
    downgrade here a bug rather than a safety net."""

    @pytest.mark.parametrize("level", ["xhigh", "max"])
    def test_named_surfaces_pass_the_level_through(self, level):
        for params, key in (
            ({"reasoning": {"effort": "medium"}}, None),
            ({"thinking_level": "medium"}, "thinking_level"),
            ({"reasoning_effort": "medium"}, "reasoning_effort"),
        ):
            apply_reasoning_effort(level, params, {})
            actual = params["reasoning"]["effort"] if key is None else params[key]
            assert actual == level

    def test_budget_surface_climbs_past_the_old_ceiling(self):
        params = {"thinking": {"type": "enabled", "budget_tokens": 10000}}
        apply_reasoning_effort("max", params, {})
        assert params["thinking"]["budget_tokens"] > _ANTHROPIC_BUDGETS["high"]

    def test_budget_ladder_walks_down_to_the_nearest_rung(self):
        """A numeric ladder need not have a rung for every canonical level; it
        takes the nearest one at or below, never one above."""
        sparse = {"low": 1024, "high": 32768}
        assert _budget(sparse, "max") == sparse["high"]
        assert _budget(sparse, "medium") == sparse["low"]
        assert _budget(sparse, "minimal") == sparse["low"]
