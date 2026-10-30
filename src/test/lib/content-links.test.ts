/**
 * Store description HTML links (v1.0.97): sanitized hrefs never point at
 * file:// (protocol-relative) or non-web schemes, and a click resolves the raw
 * href against the store origin instead of letting the window navigate.
 */
import { describe, it, expect } from 'vitest';
import { resolveContentLinkHref, sanitizeStoreHtml, EPIC_STORE_ORIGIN, STEAM_STORE_ORIGIN } from '@/lib/content-links';

describe('resolveContentLinkHref', () => {
  it('resolves store-relative paths against the source store', () => {
    expect(resolveContentLinkHref('/en-US/p/x', EPIC_STORE_ORIGIN)).toBe('https://store.epicgames.com/en-US/p/x');
    expect(resolveContentLinkHref('/app/730', STEAM_STORE_ORIGIN)).toBe('https://store.steampowered.com/app/730');
  });
  it('treats protocol-relative links as https', () => {
    expect(resolveContentLinkHref('//cdn.example/x', STEAM_STORE_ORIGIN)).toBe('https://cdn.example/x');
  });
  it('ignores in-page anchors and non-web schemes', () => {
    expect(resolveContentLinkHref('#x', STEAM_STORE_ORIGIN)).toBeNull();
    expect(resolveContentLinkHref('javascript:alert(1)', STEAM_STORE_ORIGIN)).toBeNull();
    expect(resolveContentLinkHref('file:///C:/x', STEAM_STORE_ORIGIN)).toBeNull();
    expect(resolveContentLinkHref('steam://run/1', STEAM_STORE_ORIGIN)).toBeNull();
    expect(resolveContentLinkHref('', STEAM_STORE_ORIGIN)).toBeNull();
    expect(resolveContentLinkHref(null, STEAM_STORE_ORIGIN)).toBeNull();
    expect(resolveContentLinkHref('relative/page', STEAM_STORE_ORIGIN)).toBeNull();
  });
  it('keeps absolute http(s) links', () => {
    expect(resolveContentLinkHref('https://example.com/a?b=1', STEAM_STORE_ORIGIN)).toBe('https://example.com/a?b=1');
    expect(resolveContentLinkHref('  http://example.com ', STEAM_STORE_ORIGIN)).toBe('http://example.com/');
  });
});

describe('sanitizeStoreHtml', () => {
  function hrefs(html: string): (string | null)[] {
    const div = document.createElement('div');
    div.innerHTML = sanitizeStoreHtml(html);
    return Array.from(div.querySelectorAll('a')).map((a) => a.getAttribute('href'));
  }

  it('rewrites protocol-relative hrefs to https', () => {
    expect(hrefs('<a href="//host/x">x</a>')).toEqual(['https://host/x']);
  });
  it('strips non-web hrefs but keeps the text', () => {
    const div = document.createElement('div');
    div.innerHTML = sanitizeStoreHtml('<a href="file:///C:/x">f</a><a href="ms-settings:x">m</a><a href="steam://run/1">s</a>');
    expect(Array.from(div.querySelectorAll('a')).map((a) => a.getAttribute('href'))).toEqual([null, null, null]);
    expect(div.textContent).toBe('fms');
  });
  it('keeps http(s), mailto, store-relative and hash hrefs (resolved on click)', () => {
    expect(hrefs('<a href="https://a.example">a</a><a href="mailto:x@y.z">m</a><a href="/en-US/p/x">r</a><a href="#top">h</a>'))
      .toEqual(['https://a.example', 'mailto:x@y.z', '/en-US/p/x', '#top']);
  });
  it('still removes scripts', () => {
    expect(sanitizeStoreHtml('<img src=x onerror="alert(1)"><script>alert(1)</script>')).not.toMatch(/onerror|<script/);
  });
});
