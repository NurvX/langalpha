"""What the capability map has to keep true for consent to mean anything.

Deliberately not a count of the curation. A vendor publishing a new tool, or us
curating one, is ordinary and should not fail a suite. What must never drift is
the shape: a tool reachable from a group the user declined, a group nobody
declared, or a write filed where a reader belongs.
"""

import pytest

from src.server.services import brokerage_capabilities as capabilities
from src.server.services import brokerages
from src.server.services.brokerage_capabilities import (
    GROUPS,
    UNCURATED,
    _CURATION,
    group_keys_for,
    groups_for,
    tools_for,
)
from src.server.services.brokerages import brokerage_names

VENDORS = sorted(_CURATION)


@pytest.mark.parametrize("vendor", VENDORS)
def test_no_tool_reachable_from_two_groups(vendor: str) -> None:
    """The one that would actually leak.

    A tool listed in both ``market_data`` and ``trading`` is granted by the
    former, so the trading toggle would stop meaning anything for it.
    """
    seen: dict[str, str] = {}
    for key, tools in _CURATION[vendor].items():
        for tool in tools:
            assert tool not in seen, (
                f"{vendor}.{tool} is in both {seen[tool]!r} and {key!r}"
            )
            seen[tool] = key


@pytest.mark.parametrize("vendor", VENDORS)
def test_groups_are_declared_and_ordered(vendor: str) -> None:
    declared = {g.key for g in GROUPS}
    assert set(_CURATION[vendor]) <= declared
    orders = [g.order for g in groups_for(vendor)]
    assert orders == sorted(orders)


def test_curation_only_covers_shipped_brokerages() -> None:
    """A map for a name nothing ships would never be consulted."""
    assert set(_CURATION) <= brokerage_names()


@pytest.mark.parametrize("vendor", VENDORS)
def test_granting_everything_is_the_whole_curation(vendor: str) -> None:
    every = tools_for(vendor, group_keys_for(vendor))
    assert every == frozenset().union(*_CURATION[vendor].values())


@pytest.mark.parametrize("vendor", VENDORS)
def test_granting_nothing_permits_nothing(vendor: str) -> None:
    """Empty is a real answer, and it is not the same as None."""
    assert tools_for(vendor, []) == frozenset()


def test_a_server_we_curate_nothing_for_has_no_policy() -> None:
    """None means "not ours to police", which the relay reads as no allowlist."""
    assert tools_for("some_users_own_server", ["market_data"]) is None


def test_a_shipped_brokerage_we_have_not_curated_yet_permits_nothing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The window between listing a brokerage and curating it has to fail closed.

    Listing one in BROKERAGES is what puts a Connect button on it, and that
    lands before anyone has seen the vendor's tool list to group it. Reading
    curation as the test for "is this a brokerage" would answer None here,
    which the relay reads as no policy and waves every tool through on a live
    trading connection.

    The window is staged rather than found among the shipped names. Every
    brokerage is curated today, so looking for a real one makes this pass by
    finding nothing to check -- green while testing the opposite of its name.
    """
    shipped = brokerages.Brokerage(
        name="not_curated_yet",
        label="Not Curated Yet",
        url="https://api.example.com/mcp",
        site="example.com",
        description="A brokerage listed ahead of its curation.",
    )
    monkeypatch.setattr(
        capabilities,
        "brokerage_by_name",
        lambda name: shipped if name == shipped.name else None,
    )

    assert shipped.name not in _CURATION
    assert tools_for(shipped.name, []) == frozenset()
    assert tools_for(shipped.name, ["market_data", "trading"]) == frozenset()
    # No toggles to offer, which is what keeps the consent dialog away.
    assert group_keys_for(shipped.name) == ()


@pytest.mark.parametrize("vendor", VENDORS)
def test_uncurated_tools_are_in_no_group(vendor: str) -> None:
    every = tools_for(vendor, group_keys_for(vendor))
    for tool in UNCURATED.get(vendor, ()):
        assert tool not in every


def test_the_two_tools_a_prefix_rule_misfiles() -> None:
    """Both read like reads and are not, which is why curation is by hand."""
    quotes = tools_for("moomoo", ["market_data"])
    assert "quote_modify_user_security" not in quotes
    assert "quote_modify_user_security" in tools_for("moomoo", ["watchlists"])

    # IBKR's feedback tool submits a message to the broker in the user's name.
    assert "provide_customer_feedback" in UNCURATED["ibkr"]


def test_placing_an_order_takes_the_trading_group() -> None:
    for vendor, tool in (
        ("moomoo", "trading_order_place"),
        ("robinhood", "place_equity_order"),
        # Crypto rides the same rung as equity: the group answers what the
        # action costs, not what it trades.
        ("robinhood", "place_crypto_order"),
    ):
        without = [k for k in group_keys_for(vendor) if k != "trading"]
        assert tool not in tools_for(vendor, without)
        assert tool in tools_for(vendor, ["trading"])


@pytest.mark.parametrize("vendor", ["ibkr", "webull"])
def test_a_broker_that_places_nothing_is_never_asked_about_trading(
    vendor: str,
) -> None:
    """Neither publishes a tool that places an order, so the toggle would lie."""
    assert "trading" not in group_keys_for(vendor)


def test_webull_has_no_rung_at_all() -> None:
    """Read-only by the vendor's own line, not by our reading of a tool list.

    Webull's consent screen offers account, order query, market data and
    instruments, and no trading capability, so the write scope is not grantable
    and nothing published places, previews or stages an order. IBKR by contrast
    stops one rung down rather than at zero, with a staged order a human submits.
    """
    rungs = {g.key for g in GROUPS if g.rung}
    assert not rungs & set(group_keys_for("webull"))
    assert "staged_orders" in set(group_keys_for("ibkr")) & rungs
