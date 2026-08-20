"""Upload validation for user-tier skill archives.

The pipeline accepts a zip whose root is either ``SKILL.md`` itself or a single
top-level directory containing one, walks it with zip-slip/zip-bomb guards,
parses the frontmatter with the same ``parse_skill_metadata`` the sandbox scan
uses (host and sandbox can never disagree about a skill's identity), and
re-zips deterministically so the resulting ``content_hash`` is content-
addressed: identical content re-uploaded dedups to the same storage key and
the same host cache view.

Unlike the sandbox scan — which downgrades invalid frontmatter to an
unconfirmed entry — the API *rejects*, with the specific reason.
"""

from __future__ import annotations

import functools
import io
import re
import zipfile
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
from typing import Any

import yaml

from ptc_agent.agent.middleware.skills.discovery import (
    _validate_skill_name,
    parse_skill_metadata,
)
from ptc_agent.agent.middleware.skills.registry import SKILL_REGISTRY
from src.server.services.user_skills.limits import (
    MAX_SKILL_FILES,
    MAX_SKILL_MD_BYTES,
    MAX_SKILL_SINGLE_FILE_BYTES,
    MAX_SKILL_UNCOMPRESSED_BYTES,
)

_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)

# Unix file-type bits from a zip entry's external_attr high word.
_S_IFMT = 0o170000
_S_IFREG = 0o100000

_READ_CHUNK = 64 * 1024


class SkillValidationError(Exception):
    """The archive or its SKILL.md is invalid — maps to a 400."""


@dataclass(frozen=True)
class ValidatedSkill:
    """A fully validated upload, ready to store."""

    name: str
    description: str
    license: str | None
    frontmatter: dict[str, Any]
    allowed_tools: list[str]
    skill_md: str
    canonical_zip: bytes
    content_hash: str
    file_count: int
    uncompressed_bytes: int


@functools.lru_cache(maxsize=1)
def reserved_skill_names() -> frozenset[str]:
    """Names a user skill may not take, all three sources.

    Registry keys preserve the no-shadowing invariant; command names prevent a
    user skill named e.g. ``dashboard`` from colliding with
    ``interactive-dashboard``'s slash command; repo ``skills/`` dir names catch
    shippers that never registered (e.g. ``x-api``). Static config, so caching
    at module level is safe.
    """
    names: set[str] = set(SKILL_REGISTRY)
    names.update(s.command for s in SKILL_REGISTRY.values() if s.command)
    repo_skills = Path.cwd() / "skills"
    if repo_skills.is_dir():
        names.update(p.name for p in repo_skills.iterdir() if p.is_dir())
    return frozenset(names)


def _entry_mode(info: zipfile.ZipInfo) -> int:
    return (info.external_attr >> 16) & _S_IFMT


def _clean_member_path(info: zipfile.ZipInfo) -> str | None:
    """Return the member's sanitized posix path, or None for a directory entry.

    Raises SkillValidationError on anything that could escape the extraction
    root: absolute paths, drive letters, backslashes, ``..`` components, and
    non-regular entries (symlinks, devices, fifos).
    """
    name = info.filename
    if info.is_dir():
        return None
    if "\\" in name or re.match(r"^[A-Za-z]:", name) or name.startswith("/"):
        raise SkillValidationError(f"unsafe path in archive: {name!r}")
    parts = [p for p in name.split("/") if p not in ("", ".")]
    if not parts or ".." in parts:
        raise SkillValidationError(f"unsafe path in archive: {name!r}")
    mode = _entry_mode(info)
    if mode and mode != _S_IFREG:
        raise SkillValidationError(
            f"archive entry {name!r} is not a regular file (symlinks and "
            "special files are not allowed)"
        )
    return "/".join(parts)


def _ignored(path: str) -> bool:
    """Entries the sandbox skill upload also skips."""
    parts = path.split("/")
    return "__pycache__" in parts or parts[-1] == "LICENSE.txt"


def _read_member(zf: zipfile.ZipFile, info: zipfile.ZipInfo) -> bytes:
    """Read one member with the size cap re-checked on actual bytes."""
    chunks: list[bytes] = []
    total = 0
    with zf.open(info) as fh:
        while True:
            chunk = fh.read(_READ_CHUNK)
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_SKILL_SINGLE_FILE_BYTES:
                raise SkillValidationError(
                    f"file {info.filename!r} exceeds "
                    f"{MAX_SKILL_SINGLE_FILE_BYTES} bytes"
                )
            chunks.append(chunk)
    return b"".join(chunks)


def _rejection_reason(content: str, dir_name: str) -> str:
    """Mirror parse_skill_metadata's downgrade branches to name the reason."""
    match = _FRONTMATTER_RE.match(content)
    if not match:
        return "SKILL.md must begin with YAML frontmatter (--- ... ---)"
    try:
        data = yaml.safe_load(match.group(1))
    except yaml.YAMLError as e:
        return f"invalid YAML frontmatter: {e}"
    if not isinstance(data, dict):
        return "frontmatter must be a YAML mapping"
    name = str(data.get("name", "")).strip()
    if not name:
        return "frontmatter must declare a name"
    ok, err = _validate_skill_name(name, dir_name)
    if not ok:
        return err
    if not str(data.get("description", "")).strip():
        return "frontmatter must declare a description"
    return "invalid SKILL.md frontmatter"


def _declared_name(content: str) -> str | None:
    match = _FRONTMATTER_RE.match(content)
    if not match:
        return None
    try:
        data = yaml.safe_load(match.group(1))
    except yaml.YAMLError:
        return None
    if not isinstance(data, dict):
        return None
    return str(data.get("name", "")).strip() or None


def _canonical_zip(name: str, files: dict[str, bytes]) -> bytes:
    """Deterministic re-zip: sorted names, fixed timestamps, 0644 modes.

    Determinism is what makes ``content_hash`` content-addressed — the same
    files always produce the same bytes regardless of upload order, source
    zip tool, or timestamps.
    """
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for rel in sorted(files):
            info = zipfile.ZipInfo(f"{name}/{rel}", date_time=(1980, 1, 1, 0, 0, 0))
            info.external_attr = (_S_IFREG | 0o644) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            zf.writestr(info, files[rel])
    return buf.getvalue()


def validate_skill_archive(raw: bytes) -> ValidatedSkill:
    """Validate an uploaded zip end to end; raise SkillValidationError on any
    defect. Returns the canonicalized archive plus parsed metadata."""
    try:
        zf = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile as e:
        raise SkillValidationError(f"not a valid zip archive: {e}") from e

    with zf:
        members: list[tuple[str, zipfile.ZipInfo]] = []
        header_total = 0
        for info in zf.infolist():
            path = _clean_member_path(info)
            if path is None or _ignored(path):
                continue
            # Header sizes first for a fast reject; actual bytes re-checked
            # during the read below because headers lie.
            if info.file_size > MAX_SKILL_SINGLE_FILE_BYTES:
                raise SkillValidationError(
                    f"file {path!r} exceeds {MAX_SKILL_SINGLE_FILE_BYTES} bytes"
                )
            header_total += info.file_size
            if header_total > MAX_SKILL_UNCOMPRESSED_BYTES:
                raise SkillValidationError(
                    f"archive exceeds {MAX_SKILL_UNCOMPRESSED_BYTES} bytes uncompressed"
                )
            members.append((path, info))

        if not members:
            raise SkillValidationError("archive contains no files")
        if len(members) > MAX_SKILL_FILES:
            raise SkillValidationError(
                f"archive has {len(members)} files; max is {MAX_SKILL_FILES}"
            )

        paths = {path for path, _ in members}
        top_dir: str | None = None
        if "SKILL.md" not in paths:
            top_levels = {path.split("/", 1)[0] for path in paths}
            if len(top_levels) == 1 and f"{next(iter(top_levels))}/SKILL.md" in paths:
                top_dir = next(iter(top_levels))
            else:
                raise SkillValidationError(
                    "archive must contain SKILL.md at its root or inside a "
                    "single top-level directory"
                )

        files: dict[str, bytes] = {}
        total = 0
        for path, info in members:
            rel = path[len(top_dir) + 1 :] if top_dir else path
            if not rel:
                continue
            data = _read_member(zf, info)
            total += len(data)
            if total > MAX_SKILL_UNCOMPRESSED_BYTES:
                raise SkillValidationError(
                    f"archive exceeds {MAX_SKILL_UNCOMPRESSED_BYTES} bytes uncompressed"
                )
            files[rel] = data

    skill_md_bytes = files["SKILL.md"]
    if len(skill_md_bytes) > MAX_SKILL_MD_BYTES:
        raise SkillValidationError(
            f"SKILL.md exceeds {MAX_SKILL_MD_BYTES} bytes (it is injected "
            "into the model prompt)"
        )
    try:
        skill_md = skill_md_bytes.decode("utf-8")
    except UnicodeDecodeError as e:
        raise SkillValidationError("SKILL.md is not valid UTF-8") from e

    dir_name = top_dir or _declared_name(skill_md)
    if not dir_name:
        raise SkillValidationError("frontmatter must declare a name")

    meta = parse_skill_metadata(skill_md, f"{dir_name}/SKILL.md", dir_name)
    if not meta["confirmed"]:
        raise SkillValidationError(_rejection_reason(skill_md, dir_name))
    if not meta["description"]:
        raise SkillValidationError("frontmatter must declare a description")

    name = meta["name"]
    canonical = _canonical_zip(name, files)
    frontmatter = {k: v for k, v in meta.items() if k != "path"}
    return ValidatedSkill(
        name=name,
        description=meta["description"],
        license=meta["license"],
        frontmatter=frontmatter,
        allowed_tools=list(meta["allowed_tools"]),
        skill_md=skill_md,
        canonical_zip=canonical,
        content_hash=f"sha256:{sha256(canonical).hexdigest()}",
        file_count=len(files),
        uncompressed_bytes=sum(len(v) for v in files.values()),
    )


def safe_extract_archive(zip_bytes: bytes, dest: Path) -> None:
    """Extract a stored archive under ``dest`` with the same containment guards
    as validation.

    Defense in depth for the host cache: an archive stored before a validator
    fix must still not escape the extraction root or balloon on disk.
    """
    dest = dest.resolve()
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        total = 0
        for info in zf.infolist():
            path = _clean_member_path(info)
            if path is None or _ignored(path):
                continue
            target = (dest / path).resolve()
            if not target.is_relative_to(dest):
                raise SkillValidationError(f"unsafe path in archive: {path!r}")
            data = _read_member(zf, info)
            total += len(data)
            if total > MAX_SKILL_UNCOMPRESSED_BYTES:
                raise SkillValidationError(
                    f"archive exceeds {MAX_SKILL_UNCOMPRESSED_BYTES} bytes uncompressed"
                )
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
