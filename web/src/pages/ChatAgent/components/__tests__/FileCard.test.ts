import { describe, it, expect } from 'vitest';
import { isFilePath, normalizeFilePath, parseWsPath } from '../FileCard';

describe('normalizeFilePath', () => {
  it('returns ASCII paths unchanged', () => {
    expect(normalizeFilePath('results/amd_dcf_analysis.md')).toBe('results/amd_dcf_analysis.md');
  });

  it('returns raw Unicode paths unchanged', () => {
    expect(normalizeFilePath('results/示例_分析.md')).toBe('results/示例_分析.md');
  });

  it('decodes percent-encoded CJK paths emitted by the LLM in markdown links', () => {
    // LLM occasionally emits [name](results/%XX%XX...md) — the URL position
    // in HTML/markdown is conventionally percent-encoded for non-ASCII chars.
    // 示例_分析.md → %E7%A4%BA%E4%BE%8B_%E5%88%86%E6%9E%90.md
    const encoded = 'results/%E7%A4%BA%E4%BE%8B_%E5%88%86%E6%9E%90.md';
    expect(normalizeFilePath(encoded)).toBe('results/示例_分析.md');
  });

  it('strips the __wsref__ prefix', () => {
    expect(normalizeFilePath('__wsref__/abc-123/results/report.md')).toBe('results/report.md');
  });

  it('strips __wsref__ and decodes the inner path in one pass', () => {
    // 文件.md → %E6%96%87%E4%BB%B6.md
    const encoded = '__wsref__/abc-123/results/%E6%96%87%E4%BB%B6.md';
    expect(normalizeFilePath(encoded)).toBe('results/文件.md');
  });

  it('falls through unchanged on malformed percent sequences', () => {
    // `100%discount` is a legal filename — invalid as URI escape — decode throws.
    expect(normalizeFilePath('results/100%discount.md')).toBe('results/100%discount.md');
  });
});

describe('parseWsPath', () => {
  it('parses __wsref__/{wsid}/path', () => {
    expect(parseWsPath('__wsref__/ws-1/results/r.md')).toEqual({
      workspaceId: 'ws-1',
      path: 'results/r.md',
    });
  });

  it('returns null for non-wsref paths', () => {
    expect(parseWsPath('results/r.md')).toBeNull();
    expect(parseWsPath(undefined)).toBeNull();
  });
});

describe('isFilePath', () => {
  it('treats relative links as files whatever the extension', () => {
    expect(isFilePath('results/deck.pptx')).toBe(true);
    expect(isFilePath('results/model.xlsm')).toBe(true);
    expect(isFilePath('data/prices.parquet')).toBe(true);
    expect(isFilePath('results/README')).toBe(true);
    expect(isFilePath('report.md#summary')).toBe(true);
  });

  it('treats a workspace-qualified link as a file whatever the extension', () => {
    expect(isFilePath('__wsref__/ws-1/results/deck.pptx')).toBe(true);
  });

  it('keeps URLs, anchors and app routes external', () => {
    expect(isFilePath('https://example.com/report.md')).toBe(false);
    expect(isFilePath('mailto:someone@example.com')).toBe(false);
    expect(isFilePath('//example.com/a.md')).toBe(false);
    expect(isFilePath('#section')).toBe(false);
    expect(isFilePath('?tab=files')).toBe(false);
    expect(isFilePath('www.example.com')).toBe(false);
    expect(isFilePath('/settings')).toBe(false);
  });

  it('accepts a root-absolute path that names a file', () => {
    expect(isFilePath('/tmp/output.csv')).toBe(true);
  });

  it('reads a line suffix as a file, not a URL scheme', () => {
    expect(isFilePath('model.py:42')).toBe(true);
    expect(isFilePath('work/code/model.py:40-55')).toBe(true);
    expect(isFilePath('https://example.com/model.py:42')).toBe(false);
    expect(isFilePath('www.example.com/model.py:42')).toBe(false);
  });
});

describe('normalizeFilePath fragments', () => {
  it('drops a fragment or query the link carried', () => {
    expect(normalizeFilePath('results/report.md#risks')).toBe('results/report.md');
    expect(normalizeFilePath('results/report.md?v=2')).toBe('results/report.md');
  });

  it('keeps an encoded # that belongs to the name', () => {
    expect(normalizeFilePath('results/issue%231.md')).toBe('results/issue#1.md');
  });
});
