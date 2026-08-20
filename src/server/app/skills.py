"""Skills API — the merged platform + user tier.

Anonymous callers keep the original platform-only listing (auth is optional,
not required, so no existing caller breaks); an identified caller gets the
merged view plus CRUD over their own tier. Builtin skills can be disabled per
user (stored in preferences) but never deleted; user skills are full CRUD
backed by ``user_skills`` rows + archive storage.

The default ``GET`` returns enabled rows only — it feeds the slash-command
menu. The management surface passes ``include_disabled=true`` to render
re-enable toggles.
"""

import io
import logging
import re
import zipfile
from typing import Literal, Optional

from fastapi import APIRouter, File, HTTPException, Query, Response, UploadFile
from pydantic import BaseModel, Field

from ptc_agent.agent.middleware.skills import (
    SKILL_REGISTRY,
    SkillMode,
    list_skills,
    load_skill_content,
)
from src.server.database.user_skills import (
    archive_key_in_use,
    delete_user_skill,
    get_user_skill,
    list_enabled_user_skills,
    list_user_skills,
    set_user_skill_enabled,
    upsert_user_skill,
)
from src.server.services import skill_archive_storage
from src.server.services.features import (
    get_disabled_builtin_skills,
    set_builtin_skill_disabled,
)
from src.server.services.user_skills import (
    SkillValidationError,
    fetch_skill_archive,
    reserved_skill_names,
    validate_skill_archive,
)
from src.server.services.user_skills.limits import (
    MAX_SKILL_ARCHIVE_BYTES,
    MAX_SKILL_INLINE_BLOB_BYTES,
)
from src.server.utils.api import CurrentUserId, OptionalUserId, handle_api_exceptions
from src.server.utils.uploads import read_capped

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/skills", tags=["Skills"])

# The Agent Skills name charset; also keeps {name} path params away from any
# DB or filesystem use before validation.
_NAME_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")


def _validate_name_param(name: str) -> None:
    if len(name) > 64 or not _NAME_RE.match(name):
        raise HTTPException(status_code=404, detail="Skill not found")


class SkillInfo(BaseModel):
    name: str
    description: str
    tool_count: int
    tools: list[str] = Field(default_factory=list)
    command: str | None = None
    origin: Literal["platform", "user"] = "platform"
    enabled: bool = True
    editable: bool = False
    deletable: bool = False
    confirmed: bool = True
    plugin_id: str | None = None
    size_bytes: int = 0
    updated_at: str | None = None


class SkillsResponse(BaseModel):
    skills: list[SkillInfo]


class SkillEnabledInput(BaseModel):
    enabled: bool


class SkillContentResponse(BaseModel):
    name: str
    content: str


def _user_row_to_info(row: dict) -> SkillInfo:
    return SkillInfo(
        name=row["name"],
        description=row["description"],
        tool_count=0,
        tools=[],
        command=row["name"],
        origin="user",
        enabled=bool(row["enabled"]),
        editable=True,
        deletable=True,
        confirmed=bool(row["confirmed"]),
        plugin_id=row.get("plugin_id"),
        size_bytes=int(row.get("archive_bytes") or 0),
        updated_at=row.get("updated_at"),
    )


def _platform_info(entry: dict, *, enabled: bool = True) -> SkillInfo:
    return SkillInfo(**entry, enabled=enabled)


@router.get("", response_model=SkillsResponse)
@handle_api_exceptions("list skills", logger)
async def get_skills(
    user_id: OptionalUserId,
    mode: Optional[SkillMode] = Query(
        None, description="Filter by agent mode: ptc or flash"
    ),
    include_disabled: bool = Query(
        False,
        description="Include disabled entries (management view); the default "
        "enabled-only response feeds the slash-command menu.",
    ),
):
    """List skills: platform tier always, plus the caller's user tier."""
    platform = list_skills(mode=mode)
    if user_id is None:
        return {"skills": [_platform_info(s) for s in platform]}

    disabled_builtins = await get_disabled_builtin_skills(user_id)
    skills: list[SkillInfo] = []
    for entry in platform:
        enabled = entry["name"] not in disabled_builtins
        if enabled or include_disabled:
            skills.append(_platform_info(entry, enabled=enabled))

    rows = (
        await list_user_skills(user_id)
        if include_disabled
        else await list_enabled_user_skills(user_id)
    )
    skills.extend(_user_row_to_info(r) for r in rows)
    return {"skills": skills}


@router.post("", response_model=SkillInfo, status_code=201)
@handle_api_exceptions("upload skill", logger, conflict_on_value_error=True)
async def upload_skill(
    user_id: CurrentUserId,
    file: UploadFile = File(...),
):
    """Upload a skill zip (SKILL.md at the root or in a single top-level dir).

    Re-uploading an existing name replaces it in place. Mirrors the memo
    upload's phase ordering: the slow object PUT happens before the DB write;
    on DB failure the object is deleted; a replaced row's superseded object is
    deleted after commit (unless another same-content row still references it).
    """
    raw = await read_capped(file, MAX_SKILL_ARCHIVE_BYTES)
    try:
        validated = validate_skill_archive(raw)
    except SkillValidationError as e:
        raise HTTPException(status_code=400, detail=str(e))

    if validated.name in reserved_skill_names():
        raise HTTPException(
            status_code=409,
            detail=(
                f"'{validated.name}' is reserved by a built-in skill or "
                "command; choose another name"
            ),
        )

    archive_key: str | None = None
    archive_blob: bytes | None = None
    if skill_archive_storage.is_configured():
        try:
            archive_key = await skill_archive_storage.store_archive(
                user_id=user_id,
                content=validated.canonical_zip,
                content_hash=validated.content_hash,
            )
        except skill_archive_storage.SkillArchiveUploadError as exc:
            raise HTTPException(
                status_code=502,
                detail="Could not store the skill archive — please retry.",
            ) from exc
    else:
        if len(validated.canonical_zip) > MAX_SKILL_INLINE_BLOB_BYTES:
            raise HTTPException(
                status_code=400,
                detail=(
                    "Object storage is not configured on this deployment; "
                    f"skill archives are limited to {MAX_SKILL_INLINE_BLOB_BYTES} "
                    "bytes"
                ),
            )
        archive_blob = validated.canonical_zip

    try:
        row, superseded_key = await upsert_user_skill(
            user_id,
            validated.name,
            description=validated.description,
            license=validated.license,
            frontmatter=validated.frontmatter,
            allowed_tools=validated.allowed_tools,
            confirmed=True,
            content_hash=validated.content_hash,
            archive_key=archive_key,
            archive_blob=archive_blob,
            archive_bytes=len(validated.canonical_zip),
            file_count=validated.file_count,
        )
    except BaseException:
        if archive_key:
            await skill_archive_storage.delete_archive(archive_key)
        raise

    if superseded_key and not await archive_key_in_use(superseded_key):
        await skill_archive_storage.delete_archive(superseded_key)
    return _user_row_to_info(row)


@router.patch("/{name}", response_model=SkillInfo)
@handle_api_exceptions("update skill", logger)
async def patch_skill(
    name: str,
    body: SkillEnabledInput,
    user_id: CurrentUserId,
):
    """Enable/disable a skill; dispatches on tier by name.

    A user-skill name toggles its row; a builtin name writes the per-user
    disable in preferences. The builtin disable takes effect on the next
    agent build and the next sandbox sync (which also removes the files).
    """
    _validate_name_param(name)
    row = await set_user_skill_enabled(user_id, name, body.enabled)
    if row is not None:
        return _user_row_to_info(row)

    skill = SKILL_REGISTRY.get(name)
    if skill is None:
        raise HTTPException(status_code=404, detail="Skill not found")
    disabled = await set_builtin_skill_disabled(user_id, name, disabled=not body.enabled)
    return SkillInfo(
        name=name,
        description=skill.description,
        tool_count=len(skill.get_tool_names()),
        tools=skill.get_tool_names(),
        command=skill.command,
        enabled=name not in disabled,
    )


@router.delete("/{name}", status_code=204)
@handle_api_exceptions("delete skill", logger)
async def delete_skill(name: str, user_id: CurrentUserId):
    """Delete a user skill. Builtins can be disabled, not deleted."""
    _validate_name_param(name)
    if name in reserved_skill_names():
        raise HTTPException(
            status_code=409,
            detail="Built-in skills can be disabled, not deleted",
        )
    row = await delete_user_skill(user_id, name)
    if row is None:
        raise HTTPException(status_code=404, detail="Skill not found")
    key = row.get("archive_key")
    if key and not await archive_key_in_use(key):
        await skill_archive_storage.delete_archive(key)
    return Response(status_code=204)


@router.get("/{name}/content", response_model=SkillContentResponse)
@handle_api_exceptions("read skill content", logger)
async def get_skill_content(name: str, user_id: OptionalUserId):
    """The SKILL.md text for either tier (user tier wins on name lookup —
    reserved names make a collision impossible, so this is belt-and-braces)."""
    _validate_name_param(name)
    if user_id is not None:
        row = await get_user_skill(user_id, name)
        if row is not None:
            data = await fetch_skill_archive(user_id, row)
            try:
                with zipfile.ZipFile(io.BytesIO(data)) as zf:
                    content = zf.read(f"{name}/SKILL.md").decode("utf-8")
            except (KeyError, zipfile.BadZipFile) as exc:
                logger.exception(
                    "stored skill archive unreadable (user=%s name=%s)",
                    user_id, name,
                )
                raise HTTPException(
                    status_code=502, detail="Stored skill archive is unreadable"
                ) from exc
            return {"name": name, "content": content}

    content = load_skill_content(name)
    if content is None:
        raise HTTPException(status_code=404, detail="Skill not found")
    return {"name": name, "content": content}
