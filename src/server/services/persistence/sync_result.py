"""What one sync pass saved, and every file it could not.

A caller acts differently per reason, which is why failures carry one rather
than being counted: ``too_large`` is refused the same way by every later sync
on this deployment, while the rest can save on the next pass. A caller about
to destroy the sandbox treats all of them alike, since each is a file whose
only copy is still in it.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

UnsavedReason = Literal["too_large", "unreadable", "changed", "failed"]

_REASON_PHRASES: dict[UnsavedReason, str] = {
    "too_large": "too large for this deployment's transfer path",
    "unreadable": "unreadable in the sandbox",
    "changed": "changed while being saved",
    "failed": "failed to save",
}


@dataclass(frozen=True, slots=True)
class UnsavedFile:
    path: str
    reason: UnsavedReason
    size: int | None = None


@dataclass(slots=True)
class SyncResult:
    synced: int = 0
    skipped: int = 0
    deleted: int = 0
    total_size: int = 0
    #: The largest file this deployment's transfer path can store, or ``None``
    #: when nothing but the workspace disk bounds it.
    max_file_bytes: int | None = None
    #: The project's folder is absent from this sandbox, so the pass mirrored
    #: nothing and pruned nothing; the manifest stands as the record.
    root_missing: bool = False
    unsaved: list[UnsavedFile] = field(default_factory=list)

    @property
    def errors(self) -> int:
        """Unsaved files the next sync may still save."""
        return sum(1 for f in self.unsaved if f.reason != "too_large")

    @property
    def oversized(self) -> int:
        """Unsaved files no sync on this deployment can save."""
        return sum(1 for f in self.unsaved if f.reason == "too_large")

    def describe_unsaved(self, examples: int = 3) -> str:
        """Each reason with its count and a few paths, for a log line or an error."""
        by_reason: dict[UnsavedReason, list[str]] = {}
        for f in self.unsaved:
            by_reason.setdefault(f.reason, []).append(f.path)
        parts = []
        for reason, paths in by_reason.items():
            shown = ", ".join(paths[:examples])
            more = f", +{len(paths) - examples} more" if len(paths) > examples else ""
            parts.append(f"{len(paths)} {_REASON_PHRASES[reason]}: {shown}{more}")
        return "; ".join(parts)


_USER_REASONS: dict[UnsavedReason, str] = {
    "too_large": "too large to back up",
    "unreadable": "unreadable",
    "changed": "changed while saving",
    "failed": "didn't upload",
}


class BackupIncomplete(RuntimeError):
    """A strict backup left files whose only copy is in the sandbox.

    ``str()`` is the operator's account, with ids and causes; ``user_message``
    is what the person who asked for the change can act on, naming the files.
    """

    def __init__(self, detail: str, unsaved: list[UnsavedFile] | None = None) -> None:
        super().__init__(detail)
        self.unsaved = list(unsaved or [])

    @property
    def user_message(self) -> str:
        if not self.unsaved:
            return (
                "Nothing was changed: this computer's files could not be "
                "backed up first. Try again in a moment."
            )
        shown = ", ".join(
            f"{f.path} ({_USER_REASONS[f.reason]})" for f in self.unsaved[:3]
        )
        more = len(self.unsaved) - 3
        tail = f", and {more} more" if more > 0 else ""
        count = len(self.unsaved)
        noun = "file" if count == 1 else "files"
        return (
            f"Nothing was changed: {count} {noun} could not be backed up "
            f"first: {shown}{tail}. Move or delete them, or try again."
        )
