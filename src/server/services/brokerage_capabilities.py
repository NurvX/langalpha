"""The capability groups a brokerage connection can carry, and the tools in each.

A brokerage publishes one flat tool list, and connecting one hands the agent all
of it. These groups are the unit of consent instead: the user picks which ones a
connection carries, the choice is stored on the connection, and the egress relay
refuses a call to anything outside it.

The assignment is hand-made and has to stay that way, because a prefix rule gets
it wrong in both directions. moomoo's ``quote_modify_user_security`` writes the
watchlist despite reading like a quote, and IBKR's ``provide_customer_feedback``
sends a message to the broker despite reading like nothing at all. The second is
in no group: a tool no group names is unreachable, which is also what makes a
vendor's newly published tool absent until someone curates it rather than
arriving switched on.

``rehearsal`` is the group whose meaning genuinely differs per vendor, so its
copy is per vendor too. moomoo's ``sim_trade_*`` is a parallel simulated account
that cannot touch real money; Robinhood's ``review_*_order`` is a dry run
against the real account that places nothing; IBKR's ``*_order_instruction``
writes a draft into the real account that a human can submit in one click. Three
rungs of a ladder, and only the first is play money.

Keys are facts and the words for them belong to the client, the same contract
``brokerages.py`` keeps.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass


@dataclass(frozen=True)
class CapabilityGroup:
    """One consent toggle.

    ``tone`` tells the client how loudly to draw the row without deciding the
    words: ``neutral`` is public or personal data, ``caution`` is the user's own
    positions and money, ``danger`` places real orders.
    """

    key: str
    order: int
    tone: str


GROUPS: tuple[CapabilityGroup, ...] = (
    CapabilityGroup(key="market_data", order=10, tone="neutral"),
    CapabilityGroup(key="watchlists", order=20, tone="neutral"),
    CapabilityGroup(key="scanners", order=30, tone="neutral"),
    CapabilityGroup(key="alerts", order=40, tone="neutral"),
    CapabilityGroup(key="account", order=50, tone="caution"),
    CapabilityGroup(key="rehearsal", order=60, tone="caution"),
    CapabilityGroup(key="trading", order=70, tone="danger"),
)

_BY_KEY: dict[str, CapabilityGroup] = {g.key: g for g in GROUPS}

# Tool names exactly as the vendor publishes them, which is what the relay
# compares against. Counted against live discovery: moomoo 88, Robinhood 54,
# IBKR 34, one of IBKR's deliberately left out.
_CURATION: dict[str, dict[str, tuple[str, ...]]] = {
    "moomoo": {
        "market_data": (
            "quote_capital_distribution",
            "quote_capital_flow",
            "quote_capital_flow_history",
            "quote_community_search",
            "quote_company_executive_background",
            "quote_company_executives",
            "quote_company_operational_efficiency",
            "quote_company_profile",
            "quote_corporate_actions_buybacks",
            "quote_corporate_actions_dividends",
            "quote_corporate_actions_rehab",
            "quote_corporate_actions_stock_splits",
            "quote_cur_kline",
            "quote_daily_short_volume",
            "quote_economic_calendar_hot",
            "quote_economic_calendar_search",
            "quote_financials_earnings_price_history",
            "quote_financials_earnings_price_move",
            "quote_financials_revenue_breakdown",
            "quote_financials_statements",
            "quote_future_info",
            "quote_history_kline",
            "quote_insider_holder_list",
            "quote_insider_trade_list",
            "quote_ipo_list_cn",
            "quote_ipo_list_hk",
            "quote_ipo_list_my",
            "quote_ipo_list_sg",
            "quote_ipo_list_us",
            "quote_market_snapshot",
            "quote_market_state",
            "quote_news_search",
            "quote_option_chain",
            "quote_option_exercise_probability",
            "quote_option_expiration_date",
            "quote_option_screen",
            "quote_option_volatility",
            "quote_order_book",
            "quote_owner_plate",
            "quote_plate_list",
            "quote_plate_stock",
            "quote_referencefuture_list",
            "quote_research_analyst_consensus",
            "quote_research_morningstar_report",
            "quote_research_rating_summary",
            "quote_rt_data",
            "quote_rt_ticker",
            "quote_shareholders_holder_detail",
            "quote_shareholders_holding_changes",
            "quote_shareholders_institutional",
            "quote_shareholders_overview",
            "quote_short_interest",
            "quote_stock_basicinfo",
            "quote_stock_feed",
            "quote_stock_quote",
            "quote_stock_screen",
            "quote_top_ten_brokers",
            "quote_top_ten_brokers_history",
            "quote_trading_days",
            "quote_valuation_detail",
            "quote_valuation_index_component_stock_list",
            "quote_valuation_index_stock_plate_list",
            "quote_valuation_plate_stock_list",
            "quote_warrant_screen",
        ),
        "watchlists": (
            "quote_modify_user_security",
            "quote_user_security",
            "quote_user_security_group",
        ),
        "account": (
            "account_authorized_trd_accs",
            "account_fills_history",
            "account_funds",
            "account_order_fills_today",
            "account_orders_active",
            "account_orders_detail",
            "account_orders_history",
            "account_positions",
            "account_trading_info",
        ),
        "rehearsal": (
            "sim_trade_account_list",
            "sim_trade_cancel_order",
            "sim_trade_cash_info",
            "sim_trade_history_order_list",
            "sim_trade_input_order",
            "sim_trade_max_buy_sell",
            "sim_trade_modify_order",
            "sim_trade_position_list",
        ),
        "trading": (
            "trading_order_cancel",
            "trading_order_confirm",
            "trading_order_place",
            "trading_order_replace",
        ),
    },
    "robinhood": {
        "market_data": (
            "get_earnings_calendar",
            "get_earnings_results",
            "get_equity_fundamentals",
            "get_equity_historicals",
            "get_equity_price_book",
            "get_equity_quotes",
            "get_equity_technical_indicators",
            "get_equity_tradability",
            "get_financials",
            "get_index_historicals",
            "get_index_quotes",
            "get_indexes",
            "get_option_chains",
            "get_option_historicals",
            "get_option_instruments",
            "get_option_quotes",
            "search",
        ),
        "watchlists": (
            "add_option_to_watchlist",
            "add_to_watchlist",
            "create_watchlist",
            "follow_watchlist",
            "get_option_watchlist",
            "get_popular_watchlists",
            "get_watchlist_items",
            "get_watchlists",
            "remove_from_watchlist",
            "remove_option_from_watchlist",
            "unfollow_watchlist",
            "update_watchlist",
        ),
        "scanners": (
            "create_scan",
            "get_scanner_filter_specs",
            "get_scans",
            "run_scan",
            "update_scan_config",
            "update_scan_filters",
        ),
        "account": (
            "get_accounts",
            "get_equity_orders",
            "get_equity_positions",
            "get_equity_tax_lots",
            "get_limited_margin_upgrade_info",
            "get_option_level_upgrade_info",
            "get_option_orders",
            "get_option_positions",
            "get_pnl_trade_history",
            "get_portfolio",
            "get_realized_pnl",
        ),
        "rehearsal": (
            "review_equity_order",
            "review_option_order",
        ),
        "trading": (
            "cancel_equity_order",
            "cancel_option_exercise",
            "cancel_option_order",
            "exercise_option",
            "place_equity_order",
            "place_option_order",
        ),
    },
    "ibkr": {
        "market_data": (
            "get_combo_identifier",
            "get_company_connections",
            "get_company_themes",
            "get_option_data",
            "get_option_parameters",
            "get_price_history",
            "get_price_snapshot",
            "get_theme_details",
            "search_contracts",
            "search_futures",
            "search_investment_topics",
            "whats_new",
        ),
        "watchlists": (
            "create_watchlist",
            "delete_watchlist",
            "edit_watchlist",
            "get_watchlist",
            "get_watchlists",
        ),
        "alerts": (
            "create_alert",
            "delete_alert",
            "get_alert",
            "get_alerts",
            "set_alert_status",
            "update_alert",
        ),
        "account": (
            "get_account_balances",
            "get_account_orders",
            "get_account_positions",
            "get_account_summary",
            "get_account_trades",
            "get_pa_allocation",
            "get_pa_performance_all_periods",
        ),
        "rehearsal": (
            "create_order_instruction",
            "delete_order_instruction",
            "get_order_instructions",
        ),
    },
}

# Named so a reader can see it was a decision, not an omission: this submits a
# feature request to IBKR in the user's name, which is not a thing an analysis
# turn should be able to do on its own.
UNCURATED: dict[str, tuple[str, ...]] = {
    "ibkr": ("provide_customer_feedback",),
}


def groups_for(brokerage: str) -> tuple[CapabilityGroup, ...]:
    """The consent toggles to offer for a brokerage, in display order.

    Only groups the vendor actually has tools for: IBKR publishes nothing that
    places an order, so it is never asked about trading.
    """
    curated = _CURATION.get(brokerage)
    if not curated:
        return ()
    return tuple(sorted((_BY_KEY[k] for k in curated), key=lambda g: g.order))


def group_keys_for(brokerage: str) -> tuple[str, ...]:
    """Every group key a brokerage offers, in display order."""
    return tuple(g.key for g in groups_for(brokerage))


def tools_for(brokerage: str, granted: Iterable[str]) -> frozenset[str] | None:
    """The tools a grant of these groups permits, or None if we curate no policy.

    None is not "allow nothing" and not "allow everything" — it means this
    server is not one we have a map for, and the caller decides. For a brokerage
    the answer is always a set, empty if nothing was granted, which is why
    ``policy_required`` can insist on one.
    """
    curated = _CURATION.get(brokerage)
    if curated is None:
        return None
    wanted = set(granted)
    return frozenset(
        tool for key, tools in curated.items() if key in wanted for tool in tools
    )
