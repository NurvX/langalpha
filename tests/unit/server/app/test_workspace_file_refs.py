"""A file reference the agent wrote resolves to one workspace file, or says why not.

The agent names files from the root, by bare name, or at a path it has since
moved. The server answers from the real file list so a click never opens a
namesake the reference did not mean.
"""

from __future__ import annotations

from fnmatch import fnmatchcase
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException

from src.server.app.public import resolve_shared_file
from src.server.app.workspace_files.crud import resolve_workspace_file
from src.server.app.workspace_files.file_refs import (
    ResolveFileRefRequest,
    clean_candidates,
    clean_path,
    name_glob,
    resolve_file_ref,
    visible_paths,
)

WORK_DIR = "/home/workspace"


class TestCleaning:
    def test_paths_become_workspace_relative(self):
        assert clean_path("/home/workspace/results/a.md", WORK_DIR) == "results/a.md"
        assert clean_path("././results/a.md/", WORK_DIR) == "results/a.md"
        assert clean_path("results\\a.md", WORK_DIR) == "results/a.md"

    def test_empty_or_traversing_paths_are_dropped(self):
        assert clean_path("", WORK_DIR) is None
        assert clean_path("./", WORK_DIR) is None
        assert clean_path("../etc/passwd", WORK_DIR) is None
        assert clean_path("results/../../x.md", WORK_DIR) is None

    def test_candidates_keep_one_file_name(self):
        raw = ["reports/model.py", "./model.py", "reports/model.py", "other.py", "../model.py"]
        assert clean_candidates(raw, WORK_DIR) == ["reports/model.py", "model.py"]

    def test_name_glob_matches_the_name_literally(self):
        glob = name_glob("C#1 [draft]*.md")
        assert glob == "**/C#1 [[]draft][*].md"
        pattern = glob.removeprefix("**/")
        assert fnmatchcase("C#1 [draft]*.md", pattern)
        assert not fnmatchcase("C#1 d*.md", pattern)

    def test_hidden_files_show_only_when_the_reference_points_there(self):
        paths = ["results/a.md", "_internal/a.md", "work/__pycache__/a.md"]
        assert visible_paths(paths, ["a.md"]) == ["results/a.md"]
        assert visible_paths(paths, ["_internal/a.md"]) == ["results/a.md", "_internal/a.md"]


class TestResolve:
    def test_an_exact_candidate_wins(self):
        result = resolve_file_ref(["reports/model.py", "model.py"], ["model.py", "reports/model.py"])
        assert result == {"status": "resolved", "path": "reports/model.py", "match": "exact", "matches": ["reports/model.py"]}

    def test_a_moved_file_with_a_unique_name_resolves(self):
        result = resolve_file_ref(["results/report.md"], ["archive/2026/report.md"])
        assert result["status"] == "resolved"
        assert result["path"] == "archive/2026/report.md"
        assert result["match"] == "name"

    def test_a_path_ending_in_the_reference_beats_other_namesakes(self):
        paths = ["notes/report.md", "work/q3/results/report.md"]
        result = resolve_file_ref(["results/report.md"], paths)
        assert (result["status"], result["path"], result["match"]) == ("resolved", "work/q3/results/report.md", "suffix")

    def test_a_work_file_beats_a_system_directory_namesake(self):
        result = resolve_file_ref(["report.md"], [".agents/skills/x/report.md", "results/report.md"])
        assert result["path"] == "results/report.md"

    def test_a_system_reference_can_still_land_in_a_system_directory(self):
        paths = [".agents/skills/x/SKILL.md", ".agents/skills/y/SKILL.md"]
        result = resolve_file_ref([".agents/skills/y/SKILL.md"], paths)
        assert result["path"] == ".agents/skills/y/SKILL.md"

    def test_equal_namesakes_are_ambiguous_until_this_thread_wrote_one(self):
        paths = ["a/model.py", "b/model.py"]
        ambiguous = resolve_file_ref(["model.py"], paths)
        assert ambiguous == {"status": "ambiguous", "matches": ["a/model.py", "b/model.py"]}

        written = resolve_file_ref(["model.py"], paths, recent_writes=["c/other.py", "b/model.py"])
        assert (written["status"], written["path"], written["match"]) == ("resolved", "b/model.py", "recent_write")

    def test_nothing_by_that_name_is_missing(self):
        assert resolve_file_ref(["results/report.md"], ["results/summary.md"]) == {"status": "missing", "matches": []}


def _workspace(status: str) -> dict:
    return {"workspace_id": "ws-1", "user_id": "user-1", "status": status, "config": None, "sandbox_id": "sb-1"}


def _body(*candidates: str, writes: list[str] | None = None) -> ResolveFileRefRequest:
    return ResolveFileRefRequest(candidates=list(candidates), recent_writes=writes or [])


CRUD = "src.server.app.workspace_files.crud"


@pytest.mark.asyncio
@patch(f"{CRUD}._get_work_dir", return_value=WORK_DIR)
@patch(f"{CRUD}.db_get_workspace", new_callable=AsyncMock)
class TestWorkspaceRoute:
    async def test_a_flash_workspace_has_nothing_to_search(self, mock_ws, _wd):
        mock_ws.return_value = _workspace("flash")
        result = await resolve_workspace_file("ws-1", "user-1", _body("report.md"))
        assert result == {"status": "unavailable", "reason": "flash_workspace", "matches": []}

    async def test_a_stopped_workspace_searches_its_persisted_files(self, mock_ws, _wd):
        mock_ws.return_value = _workspace("stopped")
        tree = [{"path": "results/q3/report.md"}, {"path": "results/summary.md"}, {"path": "_internal/report.md"}]
        with (
            patch(f"{CRUD}.FilePersistenceService.get_file_tree", new_callable=AsyncMock, return_value=tree),
            patch(f"{CRUD}._acquire_sandbox", new_callable=AsyncMock) as acquire,
        ):
            result = await resolve_workspace_file("ws-1", "user-1", _body("/home/workspace/report.md"))
        acquire.assert_not_awaited()
        assert result == {
            "status": "resolved", "path": "results/q3/report.md", "match": "name",
            "matches": ["results/q3/report.md"], "source": "database",
        }

    async def test_a_sandbox_still_starting_leaves_the_client_to_read_the_path(self, mock_ws, _wd):
        mock_ws.return_value = _workspace("running")
        sandbox = MagicMock()
        sandbox.is_ready.return_value = False
        sandbox.aglob_files = AsyncMock()
        with patch(f"{CRUD}._acquire_sandbox", new_callable=AsyncMock, return_value=sandbox):
            result = await resolve_workspace_file("ws-1", "user-1", _body("report.md"))
        assert result == {"status": "unavailable", "reason": "sandbox_starting", "matches": []}
        sandbox.aglob_files.assert_not_awaited()

    async def test_a_live_sandbox_is_searched_by_name(self, mock_ws, _wd):
        mock_ws.return_value = _workspace("running")
        sandbox = MagicMock()
        sandbox.is_ready.return_value = True
        sandbox.aglob_files = AsyncMock(return_value=[
            "/home/workspace/a/model.py", "/home/workspace/b/model.py", "/home/workspace/.git/x/model.py",
        ])
        sandbox.virtualize_path.side_effect = lambda p: p.removeprefix(WORK_DIR)
        with patch(f"{CRUD}._acquire_sandbox", new_callable=AsyncMock, return_value=sandbox):
            result = await resolve_workspace_file("ws-1", "user-1", _body("model.py", writes=["b/model.py"]))
        sandbox.aglob_files.assert_awaited_once_with("**/model.py", path=".")
        assert result["status"] == "resolved"
        assert (result["path"], result["match"], result["source"]) == ("b/model.py", "recent_write", "sandbox")
        assert result["matches"] == ["a/model.py", "b/model.py"]

    async def test_a_reference_with_no_usable_path_is_rejected(self, mock_ws, _wd):
        mock_ws.return_value = _workspace("running")
        with pytest.raises(HTTPException) as exc:
            await resolve_workspace_file("ws-1", "user-1", _body("../secret.md"))
        assert exc.value.status_code == 400

    async def test_another_users_workspace_is_forbidden(self, mock_ws, _wd):
        mock_ws.return_value = _workspace("running")
        with pytest.raises(HTTPException) as exc:
            await resolve_workspace_file("ws-1", "user-2", _body("report.md"))
        assert exc.value.status_code == 403


@pytest.mark.asyncio
async def test_a_shared_thread_resolves_against_the_listing_it_browses():
    listing = {"files": ["results/report.md", "archive/report.md"], "source": "database"}
    with (
        patch("src.server.app.public._get_work_dir", return_value=WORK_DIR),
        patch("src.server.app.public.list_shared_files", new_callable=AsyncMock, return_value=listing) as list_files,
    ):
        result = await resolve_shared_file("tok", _body("report.md", writes=["archive/report.md"]))
    list_files.assert_awaited_once_with("tok", path=".")
    assert result == {
        "status": "resolved", "path": "archive/report.md", "match": "recent_write",
        "matches": ["archive/report.md", "results/report.md"], "source": "database",
    }
