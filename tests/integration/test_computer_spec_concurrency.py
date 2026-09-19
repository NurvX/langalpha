"""A failed spec change cannot undo the tier another worker just provisioned."""

import asyncio

import pytest

from ptc_agent.config.agent import AgentConfig, SkillsConfig
from ptc_agent.config.core import (
    FilesystemConfig, LoggingConfig, MCPConfig, SandboxConfig, SecurityConfig,
)
from src.server.database.computer import create_computer, get_computer
from src.server.services.computer_manager import ComputerManager

pytestmark = [pytest.mark.integration, pytest.mark.asyncio(loop_scope="session")]


async def test_failed_peer_preserves_last_successful_tier(seed_user, test_db_pool):
    config = AgentConfig(
        security=SecurityConfig(), logging=LoggingConfig(), mcp=MCPConfig(),
        sandbox=SandboxConfig(provider="docker"), filesystem=FilesystemConfig(),
        skills=SkillsConfig(enabled=False),
    )
    first, second = ComputerManager(config), ComputerManager(config)
    computer = await create_computer(seed_user["user_id"], kind="docker", name="Spec race")
    computer_id = str(computer["computer_id"])
    async with test_db_pool.connection() as conn:
        await conn.execute(
            "UPDATE computers SET status='stopped', provider_ref='spec-test' WHERE computer_id=%s",
            (computer_id,),
        )
    entered, release, peer_entered = asyncio.Event(), asyncio.Event(), asyncio.Event()

    async def first_teardown(*_args, **_kwargs):
        entered.set()
        await release.wait()

    async def second_teardown(*_args, **_kwargs):
        peer_entered.set()
        raise RuntimeError("provider refused teardown")

    first._replace_stopped_sandbox = first_teardown
    second._replace_stopped_sandbox = second_teardown
    tasks = []
    try:
        tasks.append(asyncio.create_task(first.set_computer_spec(computer_id, "performance")))
        await asyncio.wait_for(entered.wait(), 5)
        tasks.append(asyncio.create_task(second.set_computer_spec(computer_id, "max")))
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(peer_entered.wait(), .1)
        release.set()
        await asyncio.wait_for(tasks[0], 5)
        with pytest.raises(RuntimeError, match="provider refused teardown"):
            await asyncio.wait_for(tasks[1], 5)
        assert (await get_computer(computer_id))["resource_tier"] == "performance"
    finally:
        release.set()
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
