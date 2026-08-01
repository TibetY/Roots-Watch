import { describe, expect, it } from 'vitest';

import { buildConfig } from '../src/index.mjs';

// Regression test: an unset GitHub Actions repository *variable* still lands
// in `env:` as an empty string rather than being omitted, so config building
// has to treat '' the same as unset — see firstDefined() in index.mjs.
describe('buildConfig', () => {
  it('falls back to defaults when env vars are unset', () => {
    const config = buildConfig([], {});
    expect(config.url).toMatch(/^https:\/\/www\.roots\.com\//);
    expect(config.sizes).toEqual(['3', '5']);
  });

  it('falls back to defaults when env vars are empty strings (GitHub Actions unset-variable case)', () => {
    const config = buildConfig([], { ROOTS_WATCH_URL: '', ROOTS_WATCH_SIZES: '' });
    expect(config.url).toMatch(/^https:\/\/www\.roots\.com\//);
    expect(config.sizes).toEqual(['3', '5']);
  });

  it('prefers a real env value over the default', () => {
    const config = buildConfig([], {
      ROOTS_WATCH_URL: 'https://www.roots.com/ca/en/other-product.html',
      ROOTS_WATCH_SIZES: 'M,L',
    });
    expect(config.url).toBe('https://www.roots.com/ca/en/other-product.html');
    expect(config.sizes).toEqual(['M', 'L']);
  });

  it('prefers a CLI flag over both env and default', () => {
    const config = buildConfig(['--url', 'https://www.roots.com/ca/en/cli-product.html', '--sizes', 'S'], {
      ROOTS_WATCH_URL: 'https://www.roots.com/ca/en/other-product.html',
    });
    expect(config.url).toBe('https://www.roots.com/ca/en/cli-product.html');
    expect(config.sizes).toEqual(['S']);
  });
});
