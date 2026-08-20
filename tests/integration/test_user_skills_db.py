"""Integration tests for the user-skill writers against real PostgreSQL.

Focused on the alias seed, which is chosen outside any lock (the handler picks
it, then spends the object PUT) and so has to be re-checked at write time.
"""

from __future__ import annotations

import uuid

import pytest

pytestmark = [pytest.mark.integration, pytest.mark.asyncio]


async def _write(user_id: str, name: str, command: str | None):
    from src.server.database.user_skills import upsert_user_skill

    row, _ = await upsert_user_skill(
        user_id,
        name,
        description=f"probe {name}",
        license=None,
        frontmatter={"name": name, "description": "probe"},
        allowed_tools=[],
        confirmed=True,
        content_hash=uuid.uuid4().hex,
        archive_key=None,
        archive_blob=b"PK\x05\x06" + b"\x00" * 18,
        archive_bytes=22,
        file_count=1,
        command=command,
    )
    return row


class TestAliasSeedUnderTheLock:
    async def test_a_seed_a_sibling_name_already_answers_to_is_dropped(
        self, seed_user, patched_get_db_connection, test_user_id
    ):
        """The sibling holds the trigger as its NAME, with a NULL command, so
        neither the unique index nor the name-vs-alias check can see it.
        """
        await _write(test_user_id, "alpha", None)

        row = await _write(test_user_id, "beta", "alpha")

        assert row["command"] is None

    async def test_a_seed_a_sibling_alias_already_answers_to_is_dropped(
        self, seed_user, patched_get_db_connection, test_user_id
    ):
        await _write(test_user_id, "alpha", "shared")

        row = await _write(test_user_id, "beta", "shared")

        assert row["command"] is None

    async def test_a_free_seed_still_lands(
        self, seed_user, patched_get_db_connection, test_user_id
    ):
        await _write(test_user_id, "alpha", None)

        row = await _write(test_user_id, "beta", "gamma")

        assert row["command"] == "gamma"


class TestDeleteClearsWorkspaceDisableMarkers:
    async def test_account_tier_delete_clears_the_markers(
        self, seed_workspace, patched_get_db_connection, test_user_id
    ):
        """The markers describe the deleted identity; a later same-name upload
        must not inherit them."""
        from src.server.database.user_skills import (
            delete_user_skill,
            list_workspace_skill_disables,
            set_workspace_skill_disable,
        )

        ws_id = seed_workspace["workspace_id"]
        await _write(test_user_id, "alpha", None)
        await set_workspace_skill_disable(ws_id, "alpha", True)

        await delete_user_skill(test_user_id, "alpha")

        assert "alpha" not in await list_workspace_skill_disables(ws_id)

    async def test_workspace_scope_delete_keeps_them(
        self, seed_workspace, patched_get_db_connection, test_user_id
    ):
        """A workspace-scoped delete re-exposes the inherited skill the marker
        points at, so the marker must survive."""
        from src.server.database.user_skills import (
            delete_user_skill,
            list_workspace_skill_disables,
            set_workspace_skill_disable,
            upsert_user_skill,
        )

        ws_id = seed_workspace["workspace_id"]
        await _write(test_user_id, "alpha", None)
        await set_workspace_skill_disable(ws_id, "alpha", True)
        await upsert_user_skill(
            test_user_id,
            "alpha",
            description="shadow",
            license=None,
            frontmatter={"name": "alpha", "description": "shadow"},
            allowed_tools=[],
            confirmed=True,
            content_hash=uuid.uuid4().hex,
            archive_key=None,
            archive_blob=b"PK\x05\x06" + b"\x00" * 18,
            archive_bytes=22,
            file_count=1,
            workspace_id=ws_id,
        )

        await delete_user_skill(test_user_id, "alpha", workspace_id=ws_id)

        assert "alpha" in await list_workspace_skill_disables(ws_id)


class TestPlatformAliasReadUnderTheLock:
    async def _seed_override(self, user_id: str, alias: str) -> None:
        from src.server.database.user import upsert_user_preferences

        await upsert_user_preferences(
            user_id,
            other_preference={"skills": {"command_overrides": {"builtin-x": alias}}},
        )

    async def test_a_command_taken_by_a_platform_alias_is_rejected(
        self, seed_user, patched_get_db_connection, test_user_id
    ):
        """set_user_skill_command re-reads the override table under the lock,
        so an alias committed after the router's friendly pre-check still
        collides."""
        from src.server.database.user_skills import set_user_skill_command

        await _write(test_user_id, "alpha", None)
        await self._seed_override(test_user_id, "taken")

        with pytest.raises(ValueError, match="already in use"):
            await set_user_skill_command(test_user_id, "alpha", "taken")

    async def test_a_seed_taken_by_a_platform_alias_is_dropped(
        self, seed_user, patched_get_db_connection, test_user_id
    ):
        await self._seed_override(test_user_id, "taken")

        row = await _write(test_user_id, "beta", "taken")

        assert row["command"] is None
