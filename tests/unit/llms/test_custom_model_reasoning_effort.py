"""A user-defined model honors the effort a user picked for it.

The level used to be resolved by looking the model up in models.json, which a
user-defined model is never in, so the request was dropped after the UI had
already offered it. The ladder now travels with the model, and these lock that:
the level reaches the request, and it is still clamped to what the entry says
it accepts.
"""

from __future__ import annotations

from src.llms.llm import create_llm_from_custom

#: An OpenAI-shaped entry, stored the way the preferences bag holds one.
_CONFIG = {
    "name": "my-own-gpt",
    "model_id": "gpt-5.5",
    "provider": "openai",
    "parameters": {"reasoning": {"effort": "medium", "summary": "auto"}},
    "reasoning_efforts": ["low", "medium", "high"],
    "reasoning_effort_default": "medium",
}


def _build(config: dict | None = None, **kwargs):
    return create_llm_from_custom(config or _CONFIG, api_key="dummy-key", **kwargs)


class TestDeclaredLadderIsHonored:
    def test_the_requested_level_reaches_the_request(self):
        client = _build(reasoning_effort="high")
        assert client.reasoning == {"effort": "high", "summary": "auto"}
        assert client.metadata["reasoning_effort"] == "high"

    def test_above_the_ladder_steps_down(self):
        """The entry's own ladder is the only ceiling this model has."""
        client = _build(reasoning_effort="max")
        assert client.reasoning == {"effort": "high", "summary": "auto"}
        assert client.metadata["reasoning_effort"] == "high"

    def test_no_request_leaves_the_entrys_own_default(self):
        client = _build()
        assert client.reasoning == {"effort": "medium", "summary": "auto"}
        assert client.metadata["reasoning_effort"] == "medium"

    def test_an_entry_with_no_ladder_stays_silent(self):
        """No declared levels means no reasoning control, not an assumed one."""
        client = _build(
            {"name": "plain", "model_id": "some-model", "provider": "openai"},
            reasoning_effort="high",
        )
        assert getattr(client, "reasoning", None) is None
        assert "reasoning_effort" not in client.metadata


class TestSurfaceResolution:
    """Where a BYOK entry's level gets written, now that the manifest declares
    it rather than leaving it to be guessed from the seed."""

    def test_a_declared_surface_is_used(self):
        client = _build(
            {
                **_CONFIG,
                "parameters": {"reasoning": {"summary": "auto"}},
                "reasoning": {
                    "efforts": ["low", "medium", "high"],
                    "default": "medium",
                    "write": "parameters.reasoning.effort",
                },
            },
            reasoning_effort="high",
        )
        assert client.reasoning == {"effort": "high", "summary": "auto"}

    def test_a_seed_only_entry_still_works(self):
        """Entries stored before the block existed carry only the flat keys and
        the seed. They keep their effort control instead of going quiet."""
        assert "reasoning" not in _CONFIG
        client = _build(reasoning_effort="high")
        assert client.reasoning == {"effort": "high", "summary": "auto"}

    def test_a_shadowing_entry_borrows_the_built_ins_surface(self):
        """It declares no surface of its own and has no seed to guess from, so
        the built-in whose name it took is the only thing that can say where
        the level goes."""
        client = _build(
            {
                "name": "gpt-5.6-sol",
                "model_id": "gpt-5.6-sol",
                "provider": "openai",
                "reasoning_efforts": ["low", "high"],
            },
            reasoning_effort="high",
        )
        assert client.reasoning == {"effort": "high"}
        assert client.metadata["reasoning_effort"] == "high"
