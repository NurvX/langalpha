"""Skills API — the merged platform + user + workspace tiers.

Anonymous callers keep the original platform-only listing (auth is optional,
not required, so no existing caller breaks); an identified caller gets the
merged view plus CRUD over their own tier. Builtin skills can be disabled per
user (stored in preferences) but never deleted; user and workspace skills are
full CRUD backed by ``user_skills`` rows + archive storage.

The workspace tier mirrors workspace MCP servers: a second router under
``/api/v1/workspaces/{id}/skills`` manages rows scoped to one workspace,
which shadow same-named user skills there; inherited skills (platform + user
tier) can be disabled per workspace but not deleted. The main ``GET`` accepts
``workspace_id`` to return the workspace-effective merged view — that is what
the slash-command menu inside a workspace reads.

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
    list_all_user_skills,
    list_enabled_user_skills,
    list_skill_disables_for_user,
    list_user_skills,
    list_workspace_skill_disables,
    move_user_skill,
    set_user_skill_enabled,
    set_workspace_skill_disable,
    upsert_user_skill,
)
from src.server.database.workspace import get_workspace as db_get_workspace
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
from src.server.utils.api import (
    CurrentUserId,
    OptionalUserId,
    handle_api_exceptions,
    require_workspace_owner,
)
from src.server.utils.uploads import read_capped

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/skills", tags=["Skills"])
workspace_router = APIRouter(prefix="/api/v1/workspaces", tags=["Skills"])

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
    origin: Literal["platform", "user", "workspace"] = "platform"
    enabled: bool = True
    editable: bool = False
    deletable: bool = False
    confirmed: bool = True
    plugin_id: str | None = None
    size_bytes: int = 0
    updated_at: str | None = None
    # Which tier switched an inherited skill off (workspace views only).
    disabled_scope: Literal["user", "workspace"] | None = None
    # Workspace row reusing (and thereby hiding) a user-tier name here.
    shadows_inherited: bool = False
    # The scope a workspace-tier row belongs to (None = user/platform tier).
    workspace_id: str | None = None
    # Workspaces where an all-workspaces skill is switched off (deny-list) —
    # populated in the all-scopes view only, for the "active in" checklist.
    disabled_workspace_ids: list[str] = Field(default_factory=list)


class SkillsResponse(BaseModel):
    skills: list[SkillInfo]


class SkillEnabledInput(BaseModel):
    enabled: bool


class SkillContentResponse(BaseModel):
    name: str
    content: str


def _user_row_to_info(
    row: dict, *, editable: bool = True, deletable: bool = True
) -> SkillInfo:
    """``editable``/``deletable`` mean "through the surface returning this row"
    — a user-tier skill listed in a workspace view is managed elsewhere."""
    return SkillInfo(
        name=row["name"],
        description=row["description"],
        tool_count=0,
        tools=[],
        command=row["name"],
        origin="workspace" if row.get("workspace_id") else "user",
        enabled=bool(row["enabled"]),
        editable=editable,
        deletable=deletable,
        confirmed=bool(row["confirmed"]),
        plugin_id=row.get("plugin_id"),
        size_bytes=int(row.get("archive_bytes") or 0),
        updated_at=row.get("updated_at"),
        workspace_id=row.get("workspace_id"),
    )


def _platform_info(entry: dict, *, enabled: bool = True) -> SkillInfo:
    return SkillInfo(**entry, enabled=enabled)


async def _require_owned_workspace(workspace_id: str, user_id: str) -> None:
    require_workspace_owner(await db_get_workspace(workspace_id), user_id=user_id)


async def _assemble_skills(
    user_id: str,
    mode: SkillMode | None,
    include_disabled: bool,
    workspace_id: str | None,
) -> dict:
    """The merged listing for one scope: platform + user tier, plus — inside a
    workspace — that workspace's rows shadowing same-named user skills and its
    disables of inherited ones."""
    platform = list_skills(mode=mode)
    disabled_builtins = await get_disabled_builtin_skills(user_id)
    ws_disabled: set[str] = (
        await list_workspace_skill_disables(workspace_id) if workspace_id else set()
    )

    skills: list[SkillInfo] = []
    for entry in platform:
        user_dis = entry["name"] in disabled_builtins
        ws_dis = entry["name"] in ws_disabled
        if not (user_dis or ws_dis):
            skills.append(_platform_info(entry))
        elif include_disabled:
            info = _platform_info(entry, enabled=False)
            # disabled_scope is a workspace-view annotation only: it tells
            # that surface which disables it cannot undo. The user view can
            # undo its own disables, so it stays unset there.
            if workspace_id is not None:
                info.disabled_scope = "user" if user_dis else "workspace"
            skills.append(info)

    user_rows = (
        await list_user_skills(user_id)
        if include_disabled
        else await list_enabled_user_skills(user_id)
    )
    ws_rows: list[dict] = []
    if workspace_id:
        ws_rows = await list_user_skills(user_id, workspace_id=workspace_id)
        if not include_disabled:
            ws_rows = [r for r in ws_rows if r["enabled"]]
    ws_names = {r["name"] for r in ws_rows}
    user_names = {r["name"] for r in user_rows}

    for r in user_rows:
        if workspace_id is None:
            skills.append(_user_row_to_info(r))
            continue
        if r["name"] in ws_names:
            # Shadowed — the workspace row below represents this name.
            continue
        row_disabled = not r["enabled"]
        ws_dis = r["name"] in ws_disabled
        if (row_disabled or ws_dis) and not include_disabled:
            continue
        info = _user_row_to_info(r, editable=False, deletable=False)
        if row_disabled:
            # A user-level disable is not workspace-reversible (mirrors the
            # MCP builtin-disable asymmetry) — surfaced so the UI can say why.
            info.disabled_scope = "user"
        elif ws_dis:
            info.enabled = False
            info.disabled_scope = "workspace"
        skills.append(info)

    for r in ws_rows:
        info = _user_row_to_info(r)
        info.shadows_inherited = r["name"] in user_names
        skills.append(info)

    return {"skills": skills}


async def _assemble_all_scopes(
    user_id: str, mode: SkillMode | None, include_disabled: bool
) -> dict:
    """Every scope at once — the Plugins page's scope-management inventory.

    No shadowing or workspace-disable filtering here: each row appears exactly
    once, tagged with its scope (``workspace_id``) and, for all-workspaces
    entries, the deny-list of workspaces that switched it off.
    """
    disabled_builtins = await get_disabled_builtin_skills(user_id)
    disables_by_name: dict[str, list[str]] = {}
    for d in await list_skill_disables_for_user(user_id):
        disables_by_name.setdefault(d["name"], []).append(d["workspace_id"])

    skills: list[SkillInfo] = []
    for entry in list_skills(mode=mode):
        user_dis = entry["name"] in disabled_builtins
        if user_dis and not include_disabled:
            continue
        info = _platform_info(entry, enabled=not user_dis)
        info.disabled_workspace_ids = sorted(
            disables_by_name.get(entry["name"], [])
        )
        skills.append(info)

    rows = await list_all_user_skills(user_id)
    user_names = {r["name"] for r in rows if not r.get("workspace_id")}
    for r in rows:
        if not r["enabled"] and not include_disabled:
            continue
        info = _user_row_to_info(r)
        if r.get("workspace_id"):
            info.shadows_inherited = r["name"] in user_names
        else:
            info.disabled_workspace_ids = sorted(
                disables_by_name.get(r["name"], [])
            )
        skills.append(info)
    return {"skills": skills}


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
    workspace_id: Optional[str] = Query(
        None,
        description="Return the workspace-effective view (workspace rows "
        "shadow user rows, workspace disables apply). Requires auth and "
        "workspace ownership.",
    ),
    all_scopes: bool = Query(
        False,
        description="Return every scope at once (user tier plus every "
        "workspace's rows, unfiltered) for scope management. Requires auth; "
        "mutually exclusive with workspace_id.",
    ),
):
    """List skills: platform tier always, plus the caller's own tiers."""
    if all_scopes:
        if user_id is None:
            raise HTTPException(status_code=401, detail="Authentication required")
        if workspace_id is not None:
            raise HTTPException(
                status_code=400,
                detail="all_scopes and workspace_id are mutually exclusive",
            )
        return await _assemble_all_scopes(user_id, mode, include_disabled)
    if workspace_id is not None:
        if user_id is None:
            raise HTTPException(status_code=401, detail="Authentication required")
        await _require_owned_workspace(workspace_id, user_id)
    if user_id is None:
        return {"skills": [_platform_info(s) for s in list_skills(mode=mode)]}
    return await _assemble_skills(user_id, mode, include_disabled, workspace_id)


async def _upload_skill_archive(
    user_id: str, file: UploadFile, *, workspace_id: str | None = None
) -> SkillInfo:
    """Shared upload pipeline for both scopes.

    Re-uploading an existing name replaces it in place (within its scope).
    Mirrors the memo upload's phase ordering: the slow object PUT happens
    before the DB write; on DB failure the object is deleted; a replaced
    row's superseded object is deleted after commit (unless another
    same-content row still references it).
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
            workspace_id=workspace_id,
        )
    except BaseException:
        if archive_key:
            await skill_archive_storage.delete_archive(archive_key)
        raise

    if superseded_key and not await archive_key_in_use(superseded_key):
        await skill_archive_storage.delete_archive(superseded_key)
    return _user_row_to_info(row)


@router.post("", response_model=SkillInfo, status_code=201)
@handle_api_exceptions("upload skill", logger, conflict_on_value_error=True)
async def upload_skill(
    user_id: CurrentUserId,
    file: UploadFile = File(...),
):
    """Upload a user-tier skill zip (SKILL.md at the root or in a single
    top-level dir); visible in every workspace."""
    return await _upload_skill_archive(user_id, file)


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


class SkillMoveInput(BaseModel):
    """Both scopes are explicit: names are only unique within one scope, so
    the source disambiguates which row moves."""

    from_workspace_id: str | None = None
    to_workspace_id: str | None = None


@router.post("/{name}/move", response_model=SkillInfo)
@handle_api_exceptions("move skill", logger)
async def move_skill(name: str, body: SkillMoveInput, user_id: CurrentUserId):
    """Re-scope a skill: user tier (every workspace) ↔ one workspace.

    The row moves in place — archive, enabled flag, and provenance travel
    with it. 409 when the destination scope already has the name (shadowing
    is created by uploading a workspace copy, never implicitly by a move).
    Platform skills have no row and cannot move.
    """
    _validate_name_param(name)
    if body.from_workspace_id == body.to_workspace_id:
        raise HTTPException(
            status_code=400, detail="The skill is already in that scope"
        )
    for ws in (body.from_workspace_id, body.to_workspace_id):
        if ws is not None:
            await _require_owned_workspace(ws, user_id)
    try:
        row = await move_user_skill(
            user_id,
            name,
            from_workspace_id=body.from_workspace_id,
            to_workspace_id=body.to_workspace_id,
        )
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    if row is None:
        raise HTTPException(status_code=404, detail="Skill not found")
    return _user_row_to_info(row)


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
async def get_skill_content(
    name: str,
    user_id: OptionalUserId,
    workspace_id: Optional[str] = Query(
        None, description="Prefer this workspace's row over the user tier."
    ),
):
    """The SKILL.md text, most specific tier first (workspace → user →
    platform; reserved names keep the platform tier collision-free, so the
    tier walk is belt-and-braces)."""
    _validate_name_param(name)
    if user_id is not None:
        row = None
        if workspace_id is not None:
            await _require_owned_workspace(workspace_id, user_id)
            row = await get_user_skill(user_id, name, workspace_id=workspace_id)
        if row is None:
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


# ---------------------------------------------------------------------------
# Workspace tier
# ---------------------------------------------------------------------------

_USER_LEVEL_DISABLED = (
    "This skill is disabled at the user level; enable it in Plugins first"
)
_INHERITED_DELETE = (
    "This skill is inherited from your Plugins. Delete it there, or "
    "disable it for this workspace."
)


@workspace_router.get("/{workspace_id}/skills", response_model=SkillsResponse)
@handle_api_exceptions("list workspace skills", logger)
async def get_workspace_skills(
    workspace_id: str,
    user_id: CurrentUserId,
    mode: Optional[SkillMode] = Query(None),
    include_disabled: bool = Query(False),
):
    """The workspace-effective merged list (management view)."""
    await _require_owned_workspace(workspace_id, user_id)
    return await _assemble_skills(user_id, mode, include_disabled, workspace_id)


@workspace_router.post(
    "/{workspace_id}/skills", response_model=SkillInfo, status_code=201
)
@handle_api_exceptions("upload workspace skill", logger, conflict_on_value_error=True)
async def upload_workspace_skill(
    workspace_id: str,
    user_id: CurrentUserId,
    file: UploadFile = File(...),
):
    """Upload a skill zip scoped to this workspace; it shadows a same-named
    user-tier skill here. Platform names stay reserved in both scopes."""
    await _require_owned_workspace(workspace_id, user_id)
    return await _upload_skill_archive(user_id, file, workspace_id=workspace_id)


@workspace_router.patch("/{workspace_id}/skills/{name}", response_model=SkillInfo)
@handle_api_exceptions("update workspace skill", logger)
async def patch_workspace_skill(
    workspace_id: str,
    name: str,
    body: SkillEnabledInput,
    user_id: CurrentUserId,
):
    """Enable/disable a skill within one workspace; dispatches on tier.

    A workspace row toggles its own flag; an inherited name (platform or user
    tier) writes a workspace-level disable. A user-level disable is not
    workspace-reversible — mirrors the MCP builtin-disable asymmetry.
    """
    _validate_name_param(name)
    await _require_owned_workspace(workspace_id, user_id)

    row = await set_user_skill_enabled(
        user_id, name, body.enabled, workspace_id=workspace_id
    )
    if row is not None:
        return _user_row_to_info(row)

    user_row = await get_user_skill(user_id, name)
    if user_row is not None:
        if not user_row["enabled"] and body.enabled:
            raise HTTPException(status_code=409, detail=_USER_LEVEL_DISABLED)
        await set_workspace_skill_disable(workspace_id, name, not body.enabled)
        info = _user_row_to_info(user_row, editable=False, deletable=False)
        if not user_row["enabled"]:
            info.disabled_scope = "user"
        elif not body.enabled:
            info.enabled = False
            info.disabled_scope = "workspace"
        return info

    skill = SKILL_REGISTRY.get(name)
    if skill is None:
        raise HTTPException(status_code=404, detail="Skill not found")
    user_disabled = name in await get_disabled_builtin_skills(user_id)
    if user_disabled and body.enabled:
        raise HTTPException(status_code=409, detail=_USER_LEVEL_DISABLED)
    await set_workspace_skill_disable(workspace_id, name, not body.enabled)
    return SkillInfo(
        name=name,
        description=skill.description,
        tool_count=len(skill.get_tool_names()),
        tools=skill.get_tool_names(),
        command=skill.command,
        enabled=body.enabled,
        disabled_scope=None if body.enabled else "workspace",
    )


@workspace_router.delete("/{workspace_id}/skills/{name}", status_code=204)
@handle_api_exceptions("delete workspace skill", logger)
async def delete_workspace_skill(
    workspace_id: str, name: str, user_id: CurrentUserId
):
    """Delete a workspace-scoped skill. Inherited skills (platform or user
    tier) can only be disabled for the workspace, not deleted through it."""
    _validate_name_param(name)
    await _require_owned_workspace(workspace_id, user_id)
    row = await delete_user_skill(user_id, name, workspace_id=workspace_id)
    if row is None:
        if name in reserved_skill_names():
            raise HTTPException(
                status_code=409,
                detail="Built-in skills can be disabled, not deleted",
            )
        if await get_user_skill(user_id, name) is not None:
            raise HTTPException(status_code=409, detail=_INHERITED_DELETE)
        raise HTTPException(status_code=404, detail="Skill not found")
    key = row.get("archive_key")
    if key and not await archive_key_in_use(key):
        await skill_archive_storage.delete_archive(key)
    return Response(status_code=204)
