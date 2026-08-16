"""Regression tests that load the REAL providers.json and models.json files.

These verify that the provider config v2 restructure (grouped format with
variants + flattening) didn't break any model-to-provider resolution.
No mocking -- these hit the actual manifest files on disk.
"""

from datetime import date

import pytest

from src.llms.llm import ModelConfig
from src.llms.pricing_utils import find_model_pricing


def _scheduled_repricings(manifest: dict) -> list[tuple[str, str, object]]:
    # Keyed on presence, not truthiness: an empty or null block is malformed,
    # and dropping it here would quietly disarm the due-date alarm below.
    return [
        (provider, entry.get("id", "<no id>"), entry["scheduled_pricing"])
        for provider, entries in manifest.get("models", {}).items()
        for entry in entries
        if "scheduled_pricing" in entry
    ]


class TestManifestIntegrity:
    @pytest.fixture
    def model_config(self):
        return ModelConfig()

    def test_every_model_resolves_to_valid_provider(self, model_config):
        """Every model in models.json must resolve to a usable provider after flatten.

        For each model entry that declares a ``provider`` field, the flattened
        provider info must:
        - exist (non-empty dict returned by get_provider_info)
        - contain a ``sdk`` key (required to instantiate the LLM client)
        - contain at least one of ``base_url`` or ``env_key`` so the provider
          is reachable (env_key may be None for oauth/dynamic providers, but
          the key itself should still be present in the dict)
        """
        failures: list[str] = []

        for model_name, model_def in model_config.llm_config.items():
            provider = model_def.get("provider")
            if provider is None:
                continue

            info = model_config.get_provider_info(provider)

            if not info:
                failures.append(
                    f"{model_name}: provider '{provider}' resolved to empty/None"
                )
                continue

            if "sdk" not in info:
                failures.append(
                    f"{model_name}: provider '{provider}' missing 'sdk' field"
                )

            has_base_url = "base_url" in info
            has_env_key = "env_key" in info
            if not (has_base_url or has_env_key):
                failures.append(
                    f"{model_name}: provider '{provider}' has neither "
                    "'base_url' nor 'env_key'"
                )

        assert not failures, (
            f"{len(failures)} model(s) failed provider resolution:\n"
            + "\n".join(f"  - {f}" for f in failures)
        )

    def test_dashscope_coding_resolves_pricing_via_parent(self, model_config):
        """dashscope-coding must either have a model with working pricing
        fallback through its parent (dashscope), or at minimum the parent
        resolution itself must work.
        """
        # Find any model that uses the dashscope-coding provider
        dc_model = None
        for model_name, model_def in model_config.llm_config.items():
            if model_def.get("provider") == "dashscope-coding":
                dc_model = (model_name, model_def)
                break

        if dc_model is not None:
            model_name, model_def = dc_model
            model_id = model_def.get("model_id", model_name)
            pricing = find_model_pricing(model_id, provider="dashscope-coding")
            assert pricing is not None, (
                f"find_model_pricing('{model_id}', provider='dashscope-coding') "
                "returned None -- parent fallback to dashscope is broken"
            )
        else:
            # No dashscope-coding model in the manifest right now, but the
            # parent resolution plumbing must still work.
            parent = model_config.get_parent_provider("dashscope-coding")
            assert parent == "dashscope", (
                f"Expected parent provider of 'dashscope-coding' to be "
                f"'dashscope', got '{parent}'"
            )

    def test_every_model_with_input_modalities_has_text(self, model_config):
        """Every model entry with input_modalities must include 'text'."""
        for model_name, model_def in model_config.llm_config.items():
            modalities = model_def.get("input_modalities")
            if modalities is not None:
                assert "text" in modalities, (
                    f"{model_name}: input_modalities missing 'text': {modalities}"
                )


class TestScheduledRepricing:
    """Vendors announce price changes ahead of the date they take effect.

    ``scheduled_pricing`` parks the announced rates on the entry; these tests
    are the alarm that goes off on the day, so the manifest can't keep billing
    yesterday's numbers unnoticed.
    """

    @pytest.fixture
    def manifest(self):
        return ModelConfig().manifest

    def test_scheduled_repricing_is_well_formed(self, manifest):
        """A malformed block would silently disarm the alarm below."""
        failures: list[str] = []

        for provider, model_id, sched in _scheduled_repricings(manifest):
            where = f"{provider}/{model_id}"

            if not isinstance(sched, dict) or not sched:
                failures.append(
                    f"{where}: scheduled_pricing is {sched!r}, want a non-empty object"
                )
                continue

            effective_from = sched.get("effective_from")
            try:
                date.fromisoformat(effective_from)
            except (TypeError, ValueError):
                failures.append(
                    f"{where}: effective_from {effective_from!r} is not ISO YYYY-MM-DD"
                )

            if not any(k in sched for k in ("input", "output", "input_tiers")):
                failures.append(f"{where}: scheduled_pricing carries no rates")

        assert not failures, "Malformed scheduled_pricing:\n" + "\n".join(
            f"  - {f}" for f in failures
        )

    def test_no_scheduled_repricing_has_come_due(self, manifest):
        """Fails from the day an announced price change takes effect.

        Evaluated against the CI run's own date, so the build goes red on the
        day rather than whenever someone next reads the manifest.
        """
        today = date.today()
        overdue: list[str] = []

        for provider, model_id, sched in _scheduled_repricings(manifest):
            if not isinstance(sched, dict):
                continue  # shape is the other test's job
            try:
                effective = date.fromisoformat(sched.get("effective_from"))
            except (TypeError, ValueError):
                continue  # shape is the other test's job
            if effective <= today:
                overdue.append(
                    f"{provider}/{model_id}: new rates took effect {effective} "
                    f"({(today - effective).days} day(s) ago)"
                )

        assert not overdue, (
            f"{len(overdue)} announced price change(s) are now live but the "
            "manifest still bills the old rates:\n"
            + "\n".join(f"  - {o}" for o in overdue)
            + "\n\nFor each: move the scheduled_pricing rates into pricing, "
            "then delete the scheduled_pricing block."
        )
