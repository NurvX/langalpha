"""Database CRUD for user-tier skills (``user_skills``).

One row per skill a user owns, carrying the denormalized SKILL.md frontmatter
so listings and the per-turn agent build never open the archive. The archive
bytes live in object storage (``archive_key``) or inline (``archive_blob``)
when no object storage is configured.

``archive_blob`` is excluded from every read except :func:`get_user_skill_archive_blob`
— it is up to half a megabyte per row, and the hot paths (listing, agent build)
need only the metadata.

``plugin_id``/``plugin_skill_dir`` mark a row as owned by an installed plugin;
:func:`detach_user_skill` clears them in place (fork-on-edit — a later plugin
update sees the name un-owned and skips it instead of overwriting).
"""

import logging
from typing import Any

from psycopg.rows import dict_row
from psycopg.types.json import Json

from src.server.database.pool import get_db_connection

logger = logging.getLogger(__name__)

# Hard cap on skills per user, mirroring MAX_CATALOG_SERVERS_PER_USER. Defined
# here (not in services/user_skills/limits.py, which re-exports them) so the
# database layer never imports from services.
MAX_SKILLS_PER_USER = 50

# Summed archive size of one user's skills. Bounds both the object-storage
# footprint and the host cache dir a sync has to materialize.
MAX_SKILL_TOTAL_BYTES_PER_USER = 32 * 1024 * 1024

# Every column except archive_blob. `has_inline_archive` lets a caller tell
# which storage backs the row without paying for the bytes.
_SKILL_COLUMNS = """
    user_skill_id, user_id, name, description, license, frontmatter,
    allowed_tools, enabled, confirmed, plugin_id, plugin_skill_dir,
    content_hash, archive_key, archive_bytes, file_count, created_at,
    updated_at, (archive_blob IS NOT NULL) AS has_inline_archive
"""


def _row_to_dict(row: dict[str, Any] | None) -> dict[str, Any] | None:
    """Normalize a raw row: UUIDs to str, timestamps to ISO 8601."""
    if row is None:
        return None
    out = dict(row)
    for key in ("user_skill_id", "plugin_id"):
        if out.get(key) is not None:
            out[key] = str(out[key])
    for key in ("created_at", "updated_at"):
        value = out.get(key)
        if value is not None and hasattr(value, "isoformat"):
            out[key] = value.isoformat()
    out["frontmatter"] = out.get("frontmatter") or {}
    out["allowed_tools"] = out.get("allowed_tools") or []
    return out


async def list_user_skills(user_id: str) -> list[dict[str, Any]]:
    """Every skill the user owns, enabled or not, ordered by name."""
    async with get_db_connection() as conn:
        async with conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(
                f"SELECT {_SKILL_COLUMNS} FROM user_skills "
                "WHERE user_id = %s ORDER BY name",
                (user_id,),
            )
            return [_row_to_dict(r) for r in await cur.fetchall()]


async def list_enabled_user_skills(user_id: str) -> list[dict[str, Any]]:
    """The agent build's input: only rows that should reach a turn.

    When the plugin entity lands, this query (and only this one) additionally
    gains the plugin-disable join predicate
    ``AND (plugin_id IS NULL OR plugin.enabled)`` — plugin-level disable
    reaches skills exclusively through this delivery chokepoint.
    """
    async with get_db_connection() as conn:
        async with conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(
                f"SELECT {_SKILL_COLUMNS} FROM user_skills "
                "WHERE user_id = %s AND enabled ORDER BY name",
                (user_id,),
            )
            return [_row_to_dict(r) for r in await cur.fetchall()]


async def get_user_skill(
    user_id: str, name: str, *, conn=None
) -> dict[str, Any] | None:
    """One skill's metadata by name, or None."""
    async with get_db_connection(conn) as db:
        async with db.cursor(row_factory=dict_row) as cur:
            await cur.execute(
                f"SELECT {_SKILL_COLUMNS} FROM user_skills "
                "WHERE user_id = %s AND name = %s",
                (user_id, name),
            )
            return _row_to_dict(await cur.fetchone())


async def get_user_skill_archive_blob(user_id: str, name: str) -> bytes | None:
    """The inline archive bytes, or None when the row is object-storage backed."""
    async with get_db_connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "SELECT archive_blob FROM user_skills "
                "WHERE user_id = %s AND name = %s",
                (user_id, name),
            )
            row = await cur.fetchone()
            if not row or row[0] is None:
                return None
            return bytes(row[0])


async def archive_key_in_use(archive_key: str) -> bool:
    """True if any row still references this storage key.

    Keys are content-addressed per user, so two same-content skills share one
    object — the caller must check this before deleting a superseded key.
    """
    async with get_db_connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "SELECT 1 FROM user_skills WHERE archive_key = %s LIMIT 1",
                (archive_key,),
            )
            return await cur.fetchone() is not None


async def upsert_user_skill(
    user_id: str,
    name: str,
    *,
    description: str,
    license: str | None,
    frontmatter: dict[str, Any],
    allowed_tools: list[str],
    confirmed: bool,
    content_hash: str,
    archive_key: str | None,
    archive_blob: bytes | None,
    archive_bytes: int,
    file_count: int,
    enabled: bool = True,
    plugin_id: str | None = None,
    plugin_skill_dir: str | None = None,
    conn=None,
) -> tuple[dict[str, Any], str | None]:
    """Insert or replace a user's skill by name.

    Returns ``(row, superseded_archive_key)`` — the caller deletes the
    superseded object after the write commits, so a failed upsert can never
    orphan the bytes the surviving row still points at.

    Both caps are enforced under an advisory lock on the user so concurrent
    uploads can't slip past them. The name being replaced is excluded from
    both counts: overwriting an existing skill is always allowed.

    On replace, ``enabled`` is preserved (a disabled skill re-uploaded stays
    disabled) while the plugin provenance columns take the caller's values —
    a direct re-upload of a plugin-owned name therefore detaches it, which is
    the fork-on-edit semantic.
    """
    async with get_db_connection(conn) as conn:
        async with conn.transaction():
            async with conn.cursor(row_factory=dict_row) as cur:
                await cur.execute(
                    "SELECT pg_advisory_xact_lock(hashtext(%s::text))", (user_id,)
                )
                await cur.execute(
                    "SELECT COUNT(*) AS cnt, "
                    "COALESCE(SUM(archive_bytes), 0) AS total_bytes "
                    "FROM user_skills WHERE user_id = %s AND name <> %s",
                    (user_id, name),
                )
                stats = await cur.fetchone()
                if stats["cnt"] >= MAX_SKILLS_PER_USER:
                    raise ValueError(
                        f"Maximum of {MAX_SKILLS_PER_USER} skills per user reached"
                    )
                if stats["total_bytes"] + archive_bytes > MAX_SKILL_TOTAL_BYTES_PER_USER:
                    raise ValueError(
                        "Skill storage limit reached "
                        f"({MAX_SKILL_TOTAL_BYTES_PER_USER} bytes per user). "
                        "Delete a skill first."
                    )

                # The row being replaced is excluded from the aggregate above,
                # so read its archive_key separately to hand back for cleanup.
                await cur.execute(
                    "SELECT archive_key FROM user_skills "
                    "WHERE user_id = %s AND name = %s FOR UPDATE",
                    (user_id, name),
                )
                prior = await cur.fetchone()
                prior_key = prior["archive_key"] if prior else None

                await cur.execute(
                    f"""
                    INSERT INTO user_skills
                        (user_id, name, description, license, frontmatter,
                         allowed_tools, enabled, confirmed, plugin_id,
                         plugin_skill_dir, content_hash, archive_key,
                         archive_blob, archive_bytes, file_count,
                         created_at, updated_at)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                            %s, %s, %s, NOW(), NOW())
                    ON CONFLICT (user_id, name) DO UPDATE SET
                        description = EXCLUDED.description,
                        license = EXCLUDED.license,
                        frontmatter = EXCLUDED.frontmatter,
                        allowed_tools = EXCLUDED.allowed_tools,
                        confirmed = EXCLUDED.confirmed,
                        plugin_id = EXCLUDED.plugin_id,
                        plugin_skill_dir = EXCLUDED.plugin_skill_dir,
                        content_hash = EXCLUDED.content_hash,
                        archive_key = EXCLUDED.archive_key,
                        archive_blob = EXCLUDED.archive_blob,
                        archive_bytes = EXCLUDED.archive_bytes,
                        file_count = EXCLUDED.file_count,
                        updated_at = NOW()
                    RETURNING {_SKILL_COLUMNS}
                    """,
                    (
                        user_id, name, description, license, Json(frontmatter),
                        Json(allowed_tools), enabled, confirmed, plugin_id,
                        plugin_skill_dir, content_hash, archive_key,
                        archive_blob, archive_bytes, file_count,
                    ),
                )
                row = _row_to_dict(await cur.fetchone())
                logger.info(
                    "[user_skills] upsert user_id=%s name=%s bytes=%d",
                    user_id, name, archive_bytes,
                )
                # Only a genuine replacement leaves an orphan, and only when the
                # new bytes landed under a different key (content-addressed keys
                # make a no-op re-upload return the same one).
                superseded = prior_key if prior_key and prior_key != archive_key else None
                return row, superseded


async def set_user_skill_enabled(
    user_id: str, name: str, enabled: bool
) -> dict[str, Any] | None:
    """Toggle a user skill. Returns the updated row, or None when absent."""
    async with get_db_connection() as conn:
        async with conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(
                f"UPDATE user_skills SET enabled = %s, updated_at = NOW() "
                f"WHERE user_id = %s AND name = %s RETURNING {_SKILL_COLUMNS}",
                (enabled, user_id, name),
            )
            return _row_to_dict(await cur.fetchone())


async def detach_user_skill(user_id: str, name: str) -> dict[str, Any] | None:
    """Clear a skill's plugin provenance in place (fork-on-edit).

    Returns the updated row, or None when absent. Idempotent on an already
    plugin-less row.
    """
    async with get_db_connection() as conn:
        async with conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(
                f"UPDATE user_skills "
                f"SET plugin_id = NULL, plugin_skill_dir = NULL, updated_at = NOW() "
                f"WHERE user_id = %s AND name = %s RETURNING {_SKILL_COLUMNS}",
                (user_id, name),
            )
            row = _row_to_dict(await cur.fetchone())
            if row:
                logger.info("[user_skills] detach user_id=%s name=%s", user_id, name)
            return row


async def delete_user_skill(
    user_id: str, name: str, *, conn=None
) -> dict[str, Any] | None:
    """Delete a user skill, returning the deleted row so the caller can drop
    its archive object. Returns None when there was nothing to delete."""
    async with get_db_connection(conn) as db:
        async with db.cursor(row_factory=dict_row) as cur:
            await cur.execute(
                f"DELETE FROM user_skills WHERE user_id = %s AND name = %s "
                f"RETURNING {_SKILL_COLUMNS}",
                (user_id, name),
            )
            row = _row_to_dict(await cur.fetchone())
            if row:
                logger.info("[user_skills] delete user_id=%s name=%s", user_id, name)
            return row
