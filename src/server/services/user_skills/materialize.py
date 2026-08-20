"""Host-side materialization of user skills + the per-turn bundle.

``resolve_user_skill_dir`` maintains a content-addressed cache view on the
host filesystem (``<root>/<user-hash>/<view-hash>/<name>/SKILL.md ...``) so the
common case — nothing changed — is a single ``stat``. The view hash covers
every enabled row's ``content_hash``, so any upload/delete/toggle produces a
new view dir and the stale one is GC'd. Concurrent workers racing to build the
same view converge via ``os.replace`` (the pattern assets.py/ptc_sandbox.py
already use).

``load_user_skill_bundle`` is the single entry point every caller uses: one
indexed query + one (Redis-cached) prefs read + the fast-path stat. There is
deliberately no extra caching layer — a per-process TTL cache would be
module-level state consulted by a request path, which AGENTS.md forbids.
"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
import tempfile
import uuid
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
from typing import Any

from src.server.database.user_skills import (
    get_user_skill_archive_blob,
    list_enabled_user_skills,
)
from src.server.services import skill_archive_storage
from src.server.services.features import get_disabled_builtin_skills
from src.server.services.user_skills.validate import safe_extract_archive

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class UserSkillSpec:
    """What the agent build needs to know about one enabled user skill."""

    name: str
    description: str
    command: str
    confirmed: bool


@dataclass(frozen=True)
class UserSkillBundle:
    """Everything the per-turn agent build consumes from the user skill tier."""

    dir: str | None
    skills: tuple[UserSkillSpec, ...]
    disabled_builtins: frozenset[str]


EMPTY_USER_SKILL_BUNDLE = UserSkillBundle(
    dir=None, skills=(), disabled_builtins=frozenset()
)


def _cache_root() -> Path:
    configured = os.environ.get("USER_SKILLS_CACHE_DIR")
    if configured:
        return Path(configured)
    return Path(tempfile.gettempdir()) / "langalpha-user-skills"


def _user_dir(user_id: str) -> Path:
    # Never raw user ids on disk.
    return _cache_root() / sha256(user_id.encode()).hexdigest()[:16]


def _view_hash(rows: list[dict[str, Any]]) -> str:
    key = "\n".join(
        f"{r['name']}:{r['content_hash']}"
        for r in sorted(rows, key=lambda r: r["name"])
    )
    return sha256(key.encode()).hexdigest()[:32]


async def fetch_skill_archive(user_id: str, row: dict[str, Any]) -> bytes:
    """The canonical archive bytes for a row, from object storage or inline."""
    if row.get("archive_key"):
        return await skill_archive_storage.fetch_archive(row["archive_key"])
    blob = await get_user_skill_archive_blob(user_id, row["name"])
    if blob is None:
        raise skill_archive_storage.SkillArchiveFetchError(
            f"skill {row['name']!r} has neither a storage key nor an inline blob"
        )
    return blob


def _extract_all(archives: list[tuple[str, bytes]], tmp: Path) -> None:
    for name, data in archives:
        safe_extract_archive(data, tmp)
        if not (tmp / name / "SKILL.md").is_file():
            raise ValueError(f"archive for {name!r} did not produce {name}/SKILL.md")


async def resolve_user_skill_dir(
    user_id: str, rows: list[dict[str, Any]]
) -> tuple[str | None, list[dict[str, Any]]]:
    """Materialize the cache view for ``rows``; return ``(dir, rows_in_view)``.

    Returns ``(None, [])`` for an empty set so users with no skills cause zero
    manifest churn. A row whose archive can't be fetched is dropped with a
    warning rather than failing the turn; the next call retries it.
    """
    if not rows:
        return None, []

    user_dir = _user_dir(user_id)
    view = user_dir / _view_hash(rows)
    if view.is_dir():
        return str(view), rows

    archives: list[tuple[str, bytes]] = []
    ok_rows: list[dict[str, Any]] = []
    for row in rows:
        try:
            archives.append((row["name"], await fetch_skill_archive(user_id, row)))
            ok_rows.append(row)
        except Exception:
            logger.exception(
                "[user_skills] archive fetch failed; skill dropped this turn "
                "(user=%s name=%s)",
                user_id,
                row["name"],
            )
    if not ok_rows:
        return None, []
    if len(ok_rows) != len(rows):
        view = user_dir / _view_hash(ok_rows)
        if view.is_dir():
            return str(view), ok_rows

    tmp = _cache_root() / ".tmp" / uuid.uuid4().hex
    tmp.mkdir(parents=True, exist_ok=True)
    try:
        await asyncio.to_thread(_extract_all, archives, tmp)
        user_dir.mkdir(parents=True, exist_ok=True)
        os.replace(tmp, view)
    except OSError:
        # ENOTEMPTY/EEXIST — another worker won the race; its view is complete.
        shutil.rmtree(tmp, ignore_errors=True)
        if not view.is_dir():
            raise
    except Exception:
        shutil.rmtree(tmp, ignore_errors=True)
        raise

    # Best-effort GC of superseded views. A concurrent turn still reading an
    # old view loses it mid-read only when the user mutated skills mid-turn —
    # accepted; the turn's next load simply re-resolves.
    try:
        for sibling in user_dir.iterdir():
            if sibling.name != view.name and sibling.is_dir():
                shutil.rmtree(sibling, ignore_errors=True)
    except OSError:
        pass

    return str(view), ok_rows


async def load_user_skill_bundle(user_id: str) -> UserSkillBundle:
    """The single entry point: enabled rows + disabled builtins + cache view."""
    rows = await list_enabled_user_skills(user_id)
    disabled = await get_disabled_builtin_skills(user_id)
    skill_dir, ok_rows = await resolve_user_skill_dir(user_id, rows)
    return UserSkillBundle(
        dir=skill_dir,
        skills=tuple(
            UserSkillSpec(
                name=r["name"],
                description=r["description"],
                command=r["name"],
                confirmed=bool(r["confirmed"]),
            )
            for r in ok_rows
        ),
        disabled_builtins=disabled,
    )


async def sandbox_skill_sync_params(
    user_id: str | None, sandbox_skills_base: str
) -> dict[str, Any]:
    """Per-user kwargs for ``sync_sandbox_assets`` (``user_skill_dir`` +
    ``disabled_skills``), empty for anonymous callers so sites can splat it
    unconditionally."""
    if not user_id:
        return {}
    bundle = await load_user_skill_bundle(user_id)
    params: dict[str, Any] = {}
    if bundle.disabled_builtins:
        params["disabled_skills"] = bundle.disabled_builtins
    if bundle.dir:
        params["user_skill_dir"] = (bundle.dir, sandbox_skills_base)
    return params
