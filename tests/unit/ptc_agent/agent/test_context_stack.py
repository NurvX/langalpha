from datetime import UTC, datetime

from ptc_agent.agent.context_stack import build_context_middleware


def _stack(**kwargs):
    return build_context_middleware(
        now=datetime(2026, 9, 13, 6, 0, tzinfo=UTC),
        guidance=None,
        model_name=None,
        sandbox_enabled=False,
        **kwargs,
    )


def test_a_failed_profile_read_leaves_the_zone_to_the_frozen_identity():
    """A build with no profile passes None, so the turn row reads the zone
    the identity block states instead of stamping UTC over it."""
    assert _stack(timezone=None, user_profile=None).turn._timezone is None
    assert (
        _stack(timezone="Asia/Shanghai", user_profile={"timezone": "Asia/Shanghai"})
        .turn._timezone
        == "Asia/Shanghai"
    )
