"""Database CRUD for user- and workspace-tier skills (``user_skills``).

One row per skill a user owns, carrying the denormalized SKILL.md frontmatter
so listings and the per-turn agent build never open the archive. The archive
bytes live in object storage (``archive_key``) or inline (``archive_blob``)
when no object storage is configured.

A row's scope is its ``workspace_id``: NULL = user tier (every workspace),
set = that workspace only. Scope-keyed functions take ``workspace_id`` and
match it exactly (``IS NOT DISTINCT FROM``); a workspace row may reuse a
user-tier name and shadows it there, so name lookups are only unique within
one scope. ``workspace_skill_disables`` records per-workspace disables of
skills the workspace merely inherits (platform + user tier), which have no
row in the workspace scope to flag.

``archive_blob`` is excluded from every read except :func:`get_user_skill_archive_blob`
— it is up to half a megabyte per row, and the hot paths (listing, agent build)
need only the metadata.

``plugin_id``/``plugin_skill_dir`` mark a row as owned by an installed plugin;
:func:`detach_user_skill` clears them in place (fork-on-edit — a later plugin
update sees the name un-owned and skips it instead of overwriting).
"""

import logging
from contextlib import asynccontextmanager
from typing import Any

from psycopg.rows import dict_row
from psycopg.types.json import Json

from src.server.database.pool import get_db_connection

logger = logging.getLogger(__name__)

# Namespace for the per-workspace skill-sync advisory lock (two-arg form).
# The reconciler holds the session-level variant across a whole pass;
# workspace-scoped content mutations (upsert/move/delete) take the xact-level
# variant so they serialize against it. Lock order is always SKILL_SYNC →
# per-user lock; for cross-workspace moves, both workspace locks sorted by id.
_SKILL_SYNC_NS = "SKILL_SYNC"


async def _lock_skill_sync_xact(cur, workspace_id: str) -> None:
    await cur.execute(
        "SELECT pg_advisory_xact_lock(hashtext(%s), hashtext(%s::text))",
        (_SKILL_SYNC_NS, workspace_id),
    )


@asynccontextmanager
async def workspace_skill_sync_lock(workspace_id: str):
    """Session-level advisory lock held across one full reconcile pass.

    Pins one pooled connection for the duration; released in ``finally`` and
    by Postgres automatically if the connection dies mid-pass.
    """
    async with get_db_connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "SELECT pg_advisory_lock(hashtext(%s), hashtext(%s::text))",
                (_SKILL_SYNC_NS, workspace_id),
            )
        try:
            yield conn
        finally:
            async with conn.cursor() as cur:
                await cur.execute(
                    "SELECT pg_advisory_unlock(hashtext(%s), hashtext(%s::text))",
                    (_SKILL_SYNC_NS, workspace_id),
                )

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
    user_skill_id, user_id, workspace_id, name, description, license,
    frontmatter, allowed_tools, enabled, confirmed, plugin_id,
    plugin_skill_dir, content_hash, archive_key, archive_bytes, file_count,
    created_at, updated_at, (archive_blob IS NOT NULL) AS has_inline_archive
"""


def _row_to_dict(row: dict[str, Any] | None) -> dict[str, Any] | None:
    """Normalize a raw row: UUIDs to str, timestamps to ISO 8601."""
    if row is None:
        return None
    out = dict(row)
    for key in ("user_skill_id", "workspace_id", "plugin_id"):
        if out.get(key) is not None:
            out[key] = str(out[key])
    for key in ("created_at", "updated_at"):
        value = out.get(key)
        if value is not None and hasattr(value, "isoformat"):
            out[key] = value.isoformat()
    out["frontmatter"] = out.get("frontmatter") or {}
    out["allowed_tools"] = out.get("allowed_tools") or []
    return out


async def list_user_skills(
    user_id: str, *, workspace_id: str | None = None
) -> list[dict[str, Any]]:
    """Every skill in one scope (user tier or one workspace), ordered by name."""
    async with get_db_connection() as conn:
        async with conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(
                f"SELECT {_SKILL_COLUMNS} FROM user_skills "
                "WHERE user_id = %s AND workspace_id IS NOT DISTINCT FROM %s "
                "ORDER BY name",
                (user_id, workspace_id),
            )
            return [_row_to_dict(r) for r in await cur.fetchall()]


async def list_all_user_skills(user_id: str) -> list[dict[str, Any]]:
    """Every skill row across every scope — the all-scopes management view."""
    async with get_db_connection() as conn:
        async with conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(
                f"SELECT {_SKILL_COLUMNS} FROM user_skills "
                "WHERE user_id = %s ORDER BY name",
                (user_id,),
            )
            return [_row_to_dict(r) for r in await cur.fetchall()]


async def list_skill_disables_for_user(user_id: str) -> list[dict[str, Any]]:
    """Per-workspace skill disables across ALL of a user's workspaces.

    Feeds the all-scopes view's per-name "active in" checklist; one query
    instead of one per workspace.
    """
    async with get_db_connection() as conn:
        async with conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(
                """
                SELECT workspace_id, name FROM workspace_skill_disables
                WHERE workspace_id IN
                    (SELECT workspace_id FROM workspaces WHERE user_id = %s)
                """,
                (user_id,),
            )
            return [
                {"workspace_id": str(r["workspace_id"]), "name": r["name"]}
                for r in await cur.fetchall()
            ]


async def list_enabled_user_skills(
    user_id: str, *, workspace_id: str | None = None
) -> list[dict[str, Any]]:
    """The agent build's input: only rows that should reach a turn.

    With a ``workspace_id`` this is the two-scope union (user tier plus that
    workspace's rows) — the caller resolves name shadowing; without one it is
    the user tier alone. When the plugin entity lands, this query (and only
    this one) additionally gains the plugin-disable join predicate
    ``AND (plugin_id IS NULL OR plugin.enabled)`` — plugin-level disable
    reaches skills exclusively through this delivery chokepoint.
    """
    scope = (
        "workspace_id IS NULL"
        if workspace_id is None
        else "(workspace_id IS NULL OR workspace_id = %s)"
    )
    params = (user_id,) if workspace_id is None else (user_id, workspace_id)
    async with get_db_connection() as conn:
        async with conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(
                f"SELECT {_SKILL_COLUMNS} FROM user_skills "
                f"WHERE user_id = %s AND enabled AND {scope} ORDER BY name",
                params,
            )
            return [_row_to_dict(r) for r in await cur.fetchall()]


async def get_user_skill(
    user_id: str, name: str, *, workspace_id: str | None = None, conn=None
) -> dict[str, Any] | None:
    """One skill's metadata by scope and name, or None."""
    async with get_db_connection(conn) as db:
        async with db.cursor(row_factory=dict_row) as cur:
            await cur.execute(
                f"SELECT {_SKILL_COLUMNS} FROM user_skills "
                "WHERE user_id = %s AND name = %s "
                "AND workspace_id IS NOT DISTINCT FROM %s",
                (user_id, name, workspace_id),
            )
            return _row_to_dict(await cur.fetchone())


async def get_user_skill_archive_blob(
    user_id: str, user_skill_id: str
) -> bytes | None:
    """The inline archive bytes, or None when the row is object-storage backed.

    Keyed by row id, not name — with workspace shadowing, a name no longer
    identifies one row per user.
    """
    async with get_db_connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "SELECT archive_blob FROM user_skills "
                "WHERE user_id = %s AND user_skill_id = %s",
                (user_id, user_skill_id),
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


async def _check_skill_caps(
    cur, user_id: str, name: str, workspace_id: str | None, archive_bytes: int
) -> None:
    """Per-user count/bytes caps; the exact row being replaced is excluded so
    overwriting an existing skill is always allowed. Caller holds the per-user
    advisory lock."""
    await cur.execute(
        "SELECT COUNT(*) AS cnt, "
        "COALESCE(SUM(archive_bytes), 0) AS total_bytes "
        "FROM user_skills WHERE user_id = %s AND NOT "
        "(name = %s AND workspace_id IS NOT DISTINCT FROM %s)",
        (user_id, name, workspace_id),
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
    workspace_id: str | None = None,
    plugin_id: str | None = None,
    plugin_skill_dir: str | None = None,
    conn=None,
) -> tuple[dict[str, Any], str | None]:
    """Insert or replace a skill by scope and name.

    Returns ``(row, superseded_archive_key)`` — the caller deletes the
    superseded object after the write commits, so a failed upsert can never
    orphan the bytes the surviving row still points at.

    Both caps are per user across every scope, enforced under an advisory
    lock on the user so concurrent uploads can't slip past them. The exact
    row being replaced (scope + name) is excluded from both counts:
    overwriting an existing skill is always allowed.

    On replace, ``enabled`` is preserved (a disabled skill re-uploaded stays
    disabled) while the plugin provenance columns take the caller's values —
    a direct re-upload of a plugin-owned name therefore detaches it, which is
    the fork-on-edit semantic.
    """
    async with get_db_connection(conn) as conn:
        async with conn.transaction():
            async with conn.cursor(row_factory=dict_row) as cur:
                if workspace_id is not None:
                    await _lock_skill_sync_xact(cur, workspace_id)
                await cur.execute(
                    "SELECT pg_advisory_xact_lock(hashtext(%s::text))", (user_id,)
                )
                await _check_skill_caps(cur, user_id, name, workspace_id, archive_bytes)

                # The row being replaced is excluded from the aggregate above,
                # so read its archive_key separately to hand back for cleanup.
                await cur.execute(
                    "SELECT archive_key FROM user_skills "
                    "WHERE user_id = %s AND name = %s "
                    "AND workspace_id IS NOT DISTINCT FROM %s FOR UPDATE",
                    (user_id, name, workspace_id),
                )
                prior = await cur.fetchone()
                prior_key = prior["archive_key"] if prior else None

                # Uniqueness is a partial index per scope, so ON CONFLICT must
                # name the matching index's columns + predicate to infer it.
                conflict_target = (
                    "(user_id, name) WHERE workspace_id IS NULL"
                    if workspace_id is None
                    else "(workspace_id, name) WHERE workspace_id IS NOT NULL"
                )
                await cur.execute(
                    f"""
                    INSERT INTO user_skills
                        (user_id, workspace_id, name, description,
                         license, frontmatter, allowed_tools, enabled,
                         confirmed, plugin_id, plugin_skill_dir, content_hash,
                         archive_key, archive_blob, archive_bytes, file_count,
                         created_at, updated_at)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                            %s, %s, %s, %s, %s, NOW(), NOW())
                    ON CONFLICT {conflict_target} DO UPDATE SET
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
                        user_id, workspace_id, name, description,
                        license, Json(frontmatter), Json(allowed_tools),
                        enabled, confirmed, plugin_id, plugin_skill_dir,
                        content_hash, archive_key, archive_blob, archive_bytes,
                        file_count,
                    ),
                )
                row = _row_to_dict(await cur.fetchone())
                logger.info(
                    "[user_skills] upsert user_id=%s workspace_id=%s name=%s bytes=%d",
                    user_id, workspace_id, name, archive_bytes,
                )
                # Only a genuine replacement leaves an orphan, and only when the
                # new bytes landed under a different key (content-addressed keys
                # make a no-op re-upload return the same one).
                superseded = prior_key if prior_key and prior_key != archive_key else None
                return row, superseded


async def move_user_skill(
    user_id: str,
    name: str,
    *,
    from_workspace_id: str | None,
    to_workspace_id: str | None,
) -> dict[str, Any] | None:
    """Re-scope a skill row (user tier ↔ one workspace) in place.

    Raises ValueError when the name is taken in the target scope; returns None
    when no row exists in the source scope. Runs under the same per-user
    advisory lock as uploads, so the collision check and the update cannot
    race a concurrent upsert. Any per-workspace disable of this name in the
    two workspaces involved is cleared: the move is an explicit statement
    that the skill is wanted where it now lives (and it was live where it
    just left).
    """
    async with get_db_connection() as conn:
        async with conn.transaction():
            async with conn.cursor(row_factory=dict_row) as cur:
                for ws in sorted(
                    {w for w in (from_workspace_id, to_workspace_id) if w}
                ):
                    await _lock_skill_sync_xact(cur, ws)
                await cur.execute(
                    "SELECT pg_advisory_xact_lock(hashtext(%s::text))", (user_id,)
                )
                await cur.execute(
                    "SELECT 1 FROM user_skills WHERE user_id = %s AND name = %s "
                    "AND workspace_id IS NOT DISTINCT FROM %s",
                    (user_id, name, to_workspace_id),
                )
                if await cur.fetchone() is not None:
                    raise ValueError(
                        f"A skill named {name!r} already exists in the "
                        "destination scope"
                    )
                await cur.execute(
                    f"UPDATE user_skills SET workspace_id = %s, updated_at = NOW() "
                    "WHERE user_id = %s AND name = %s "
                    "AND workspace_id IS NOT DISTINCT FROM %s "
                    f"RETURNING {_SKILL_COLUMNS}",
                    (to_workspace_id, user_id, name, from_workspace_id),
                )
                row = _row_to_dict(await cur.fetchone())
                if row is None:
                    return None
                for ws in (from_workspace_id, to_workspace_id):
                    if ws is not None:
                        await cur.execute(
                            "DELETE FROM workspace_skill_disables "
                            "WHERE workspace_id = %s AND name = %s",
                            (ws, name),
                        )
                logger.info(
                    "[user_skills] move user_id=%s name=%s from=%s to=%s",
                    user_id, name, from_workspace_id, to_workspace_id,
                )
                return row


async def set_user_skill_enabled(
    user_id: str, name: str, enabled: bool, *, workspace_id: str | None = None
) -> dict[str, Any] | None:
    """Toggle a skill row in one scope. Returns the row, or None when absent."""
    async with get_db_connection() as conn:
        async with conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(
                f"UPDATE user_skills SET enabled = %s, updated_at = NOW() "
                f"WHERE user_id = %s AND name = %s "
                f"AND workspace_id IS NOT DISTINCT FROM %s "
                f"RETURNING {_SKILL_COLUMNS}",
                (enabled, user_id, name, workspace_id),
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
                f"WHERE user_id = %s AND name = %s AND workspace_id IS NULL "
                f"RETURNING {_SKILL_COLUMNS}",
                (user_id, name),
            )
            row = _row_to_dict(await cur.fetchone())
            if row:
                logger.info("[user_skills] detach user_id=%s name=%s", user_id, name)
            return row


async def delete_user_skill(
    user_id: str, name: str, *, workspace_id: str | None = None, conn=None
) -> dict[str, Any] | None:
    """Delete a skill row in one scope, returning it so the caller can drop
    its archive object. Returns None when there was nothing to delete."""
    async with get_db_connection(conn) as db:
        async with db.transaction():
            async with db.cursor(row_factory=dict_row) as cur:
                if workspace_id is not None:
                    await _lock_skill_sync_xact(cur, workspace_id)
                await cur.execute(
                    f"DELETE FROM user_skills WHERE user_id = %s AND name = %s "
                    f"AND workspace_id IS NOT DISTINCT FROM %s "
                    f"RETURNING {_SKILL_COLUMNS}",
                    (user_id, name, workspace_id),
                )
                row = _row_to_dict(await cur.fetchone())
                if row:
                    logger.info(
                        "[user_skills] delete user_id=%s workspace_id=%s name=%s",
                        user_id, workspace_id, name,
                    )
                return row


async def get_user_skill_by_id(
    user_id: str, user_skill_id: str
) -> dict[str, Any] | None:
    """One skill row by UUID, any scope — how the reconciler tells a moved
    row (UUID survives ``move_user_skill``) from a deleted one."""
    async with get_db_connection() as conn:
        async with conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(
                f"SELECT {_SKILL_COLUMNS} FROM user_skills "
                "WHERE user_id = %s AND user_skill_id = %s",
                (user_id, user_skill_id),
            )
            return _row_to_dict(await cur.fetchone())


async def create_user_skill(
    user_id: str,
    name: str,
    *,
    workspace_id: str,
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
) -> dict[str, Any] | None:
    """Create-only insert for auto-import: never replaces an existing row.

    Returns None when the name is already taken in the scope (the reconciler
    re-decides via the arbiter); raises ValueError on caps.
    """
    async with get_db_connection() as conn:
        async with conn.transaction():
            async with conn.cursor(row_factory=dict_row) as cur:
                await cur.execute(
                    "SELECT pg_advisory_xact_lock(hashtext(%s::text))", (user_id,)
                )
                await _check_skill_caps(cur, user_id, name, workspace_id, archive_bytes)
                await cur.execute(
                    f"""
                    INSERT INTO user_skills
                        (user_id, workspace_id, name, description,
                         license, frontmatter, allowed_tools, enabled,
                         confirmed, content_hash, archive_key, archive_blob,
                         archive_bytes, file_count, created_at, updated_at)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, TRUE, %s, %s, %s,
                            %s, %s, %s, NOW(), NOW())
                    ON CONFLICT (workspace_id, name) WHERE workspace_id IS NOT NULL
                        DO NOTHING
                    RETURNING {_SKILL_COLUMNS}
                    """,
                    (
                        user_id, workspace_id, name, description,
                        license, Json(frontmatter), Json(allowed_tools),
                        confirmed, content_hash, archive_key, archive_blob,
                        archive_bytes, file_count,
                    ),
                )
                row = _row_to_dict(await cur.fetchone())
                if row:
                    logger.info(
                        "[user_skills] auto-import user_id=%s workspace_id=%s name=%s",
                        user_id, workspace_id, name,
                    )
                return row


async def update_user_skill_content_cas(
    user_id: str,
    user_skill_id: str,
    expected_content_hash: str,
    *,
    description: str,
    license: str | None,
    frontmatter: dict[str, Any],
    allowed_tools: list[str],
    content_hash: str,
    archive_key: str | None,
    archive_blob: bytes | None,
    archive_bytes: int,
    file_count: int,
) -> tuple[dict[str, Any] | None, str | None]:
    """Pull-up write: replace a row's content only if it still carries the
    hash the reconciler observed. Returns ``(row, superseded_archive_key)``;
    ``(None, None)`` = CAS lost, the caller re-decides next pass."""
    async with get_db_connection() as conn:
        async with conn.transaction():
            async with conn.cursor(row_factory=dict_row) as cur:
                await cur.execute(
                    "SELECT pg_advisory_xact_lock(hashtext(%s::text))", (user_id,)
                )
                await cur.execute(
                    "SELECT name, workspace_id, archive_key FROM user_skills "
                    "WHERE user_id = %s AND user_skill_id = %s "
                    "AND content_hash = %s FOR UPDATE",
                    (user_id, user_skill_id, expected_content_hash),
                )
                prior = await cur.fetchone()
                if prior is None:
                    return None, None
                await _check_skill_caps(
                    cur, user_id, prior["name"], prior["workspace_id"], archive_bytes
                )
                await cur.execute(
                    f"""
                    UPDATE user_skills SET
                        description = %s, license = %s, frontmatter = %s,
                        allowed_tools = %s, content_hash = %s, archive_key = %s,
                        archive_blob = %s, archive_bytes = %s, file_count = %s,
                        updated_at = NOW()
                    WHERE user_id = %s AND user_skill_id = %s
                    RETURNING {_SKILL_COLUMNS}
                    """,
                    (
                        description, license, Json(frontmatter),
                        Json(allowed_tools), content_hash, archive_key,
                        archive_blob, archive_bytes, file_count,
                        user_id, user_skill_id,
                    ),
                )
                row = _row_to_dict(await cur.fetchone())
                prior_key = prior["archive_key"]
                superseded = (
                    prior_key if prior_key and prior_key != archive_key else None
                )
                logger.info(
                    "[user_skills] pull-up user_id=%s skill_id=%s",
                    user_id, user_skill_id,
                )
                return row, superseded


async def delete_user_skill_cas(
    user_id: str, user_skill_id: str, expected_content_hash: str
) -> dict[str, Any] | None:
    """Deletion propagation: drop a row only if its content is still exactly
    what the ledger last synced (content beats deletion). None = CAS lost."""
    async with get_db_connection() as conn:
        async with conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(
                f"DELETE FROM user_skills WHERE user_id = %s "
                "AND user_skill_id = %s AND content_hash = %s "
                f"RETURNING {_SKILL_COLUMNS}",
                (user_id, user_skill_id, expected_content_hash),
            )
            row = _row_to_dict(await cur.fetchone())
            if row:
                logger.info(
                    "[user_skills] sync-delete user_id=%s skill_id=%s name=%s",
                    user_id, user_skill_id, row["name"],
                )
            return row


async def list_workspace_skill_disables(workspace_id: str) -> set[str]:
    """Names of inherited skills this workspace has switched off."""
    async with get_db_connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "SELECT name FROM workspace_skill_disables WHERE workspace_id = %s",
                (workspace_id,),
            )
            return {r[0] for r in await cur.fetchall()}


async def set_workspace_skill_disable(
    workspace_id: str, name: str, disabled: bool
) -> None:
    """Record or clear a workspace-level disable of an inherited skill."""
    async with get_db_connection() as conn:
        async with conn.cursor() as cur:
            if disabled:
                await cur.execute(
                    "INSERT INTO workspace_skill_disables (workspace_id, name) "
                    "VALUES (%s, %s) ON CONFLICT DO NOTHING",
                    (workspace_id, name),
                )
            else:
                await cur.execute(
                    "DELETE FROM workspace_skill_disables "
                    "WHERE workspace_id = %s AND name = %s",
                    (workspace_id, name),
                )
