/**
 * The join between a shipped brokerage and the row it may or may not have yet.
 *
 * The registry itself is the backend's, so what is worth pinning here is the
 * one thing the page derives from it: a host match that decides whether a row
 * carries a vendor's constraints, including whether someone is told to go
 * install a desktop app. Being wrong costs a user a download they did not need
 * or a dead end they were not warned about, so it is pinned both ways.
 */
import { describe, expect, it } from 'vitest';
import enUS from '@/locales/en-US.json';
import zhCN from '@/locales/zh-CN.json';

import { brokerageForUrl, connectAsks, defaultGrant, type Brokerage } from '../brokerages';

const robinhood: Brokerage = {
  name: 'robinhood',
  label: 'Robinhood',
  url: 'https://agent.robinhood.com/mcp/trading',
  description: 'Robinhood brokerage account.',
  native_callback_only: true,
  exclusive_connection: false,
  capabilities: [
    { key: 'market_data', tone: 'neutral' },
    { key: 'account', tone: 'caution' },
    { key: 'trading', tone: 'danger' },
  ],
};

const ibkr: Brokerage = {
  name: 'ibkr',
  label: 'Interactive Brokers',
  url: 'https://api.ibkr.com/v1/api/mcp-public',
  description: 'Interactive Brokers account.',
  native_callback_only: false,
  exclusive_connection: true,
  capabilities: [
    { key: 'market_data', tone: 'neutral' },
    { key: 'rehearsal', tone: 'caution' },
  ],
};

const all = [robinhood, ibkr];

describe('brokerageForUrl', () => {
  it.each([
    ['https://agent.robinhood.com/mcp/trading', 'robinhood'],
    // A row is the user's to edit once it exists, and a different path on the
    // same vendor host is still that vendor.
    ['https://agent.robinhood.com/mcp/other', 'robinhood'],
    ['https://AGENT.RobinHood.com/mcp/trading', 'robinhood'],
    ['https://api.ibkr.com/v1/api/mcp-public', 'ibkr'],
  ])('%s → %s', (url, name) => {
    expect(brokerageForUrl(url, all)?.name).toBe(name);
  });

  it.each([
    // A neighbouring host is a different server; claiming a vendor's
    // constraints for it would be a guess.
    ['https://robinhood.com/mcp'],
    ['https://agent.robinhood.com.example.test/mcp'],
    ['https://mcp.example.com/sse'],
    ['not a url'],
    [null],
    [undefined],
  ])('%s matches nothing', (url) => {
    expect(brokerageForUrl(url as string | null, all)).toBeNull();
  });

  it('matches nothing at all when the registry has not loaded', () => {
    expect(brokerageForUrl(robinhood.url, [])).toBeNull();
  });
});

describe('the quirks read off a match', () => {
  // Both quirks come from the same match, so a row at a vendor's host carries
  // both of that vendor's constraints or neither. Splitting the two joins is
  // how one of them ends up applying to a row the other skips.
  it('carries whatever the matched vendor carries, and nothing otherwise', () => {
    expect(brokerageForUrl(robinhood.url, all)?.native_callback_only).toBe(true);
    expect(brokerageForUrl(robinhood.url, all)?.exclusive_connection).toBe(false);
    expect(brokerageForUrl(ibkr.url, all)?.native_callback_only).toBe(false);
    expect(brokerageForUrl(ibkr.url, all)?.exclusive_connection).toBe(true);
    expect(brokerageForUrl('https://mcp.example.com/sse', all)).toBeNull();
  });
});

/**
 * What a connect starts out granting, which is every group the vendor offers
 * except the ones that place real orders.
 *
 * Pinned on the tone rather than on the key, because that is what the rule
 * actually reads: a group added at the backend arrives here as a tone this
 * build may have no name for, and it has to land on the right side of the line
 * without a release.
 */
describe('defaultGrant', () => {
  it('ticks everything a vendor offers short of real orders', () => {
    expect(defaultGrant(robinhood)).toEqual(['market_data', 'account']);
  });

  it('ticks all of a vendor that cannot place one at all', () => {
    expect(defaultGrant(ibkr)).toEqual(['market_data', 'rehearsal']);
  });

  it('has nothing to tick for a row that is no brokerage', () => {
    expect(defaultGrant(null)).toEqual([]);
  });
});

describe('connectAsks', () => {
  it('asks about anything a brokerage can be granted', () => {
    expect(connectAsks(robinhood)).toBe(true);
  });

  it("asks about a vendor's own terms even with nothing to grant", () => {
    expect(connectAsks({ ...ibkr, capabilities: [] })).toBe(true);
  });

  it('asks nothing of an ordinary OAuth server', () => {
    expect(connectAsks(null)).toBe(false);
    expect(connectAsks(undefined)).toBe(false);
  });

  // A vendor with neither is connected on the click, as every OAuth server on
  // the Connectors tab always has been.
  it('asks nothing of a brokerage with no terms and no groups', () => {
    expect(
      connectAsks({ ...robinhood, exclusive_connection: false, capabilities: [] }),
    ).toBe(false);
  });
});

/**
 * Every group the backend can offer has a sentence in both catalogs.
 *
 * The dialog reads these as `t(`plugins.brokerages.capabilities.${key}.label`)`,
 * a template the tree-wide locale sweep cannot see, so nothing else notices one
 * going missing. What the user would then be shown is a raw key beside a switch
 * that decides whether an agent may spend their money.
 *
 * The list mirrors `GROUPS` in `src/server/services/brokerage_capabilities.py`,
 * which is the only place it exists; a group added there and not here ships
 * untranslated, and this is the reminder.
 */
describe('the capability group sentences', () => {
  it.each([
    'market_data',
    'watchlists',
    'scanners',
    'alerts',
    'account',
    'rehearsal',
    'trading',
  ])('%s reads in both catalogs', (key) => {
    for (const catalog of [enUS, zhCN]) {
      const groups = (
        catalog as {
          plugins: {
            brokerages: { capabilities: Record<string, Record<string, string>> };
          };
        }
      ).plugins.brokerages.capabilities;
      expect(typeof groups[key]?.label).toBe('string');
      expect(typeof groups[key]?.desc).toBe('string');
    }
  });

  // `rehearsal` is the group whose meaning is genuinely different at each
  // broker: play money at one, a dry run against the real account at the next,
  // a draft order a human can submit in one click at the third. The generic
  // sentence is the fallback and is true of none of them in particular, so a
  // shipped vendor missing its own is the sentence being wrong rather than
  // absent.
  it.each(['moomoo', 'robinhood', 'ibkr'])('rehearsal says what it means at %s', (vendor) => {
    for (const catalog of [enUS, zhCN]) {
      const rehearsal = (
        catalog as {
          plugins: {
            brokerages: { capabilities: { rehearsal: Record<string, string> } };
          };
        }
      ).plugins.brokerages.capabilities.rehearsal;
      expect(typeof rehearsal[`desc_${vendor}`]).toBe('string');
    }
  });
});
