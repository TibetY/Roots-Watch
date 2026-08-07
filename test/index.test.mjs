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

  // The Actions workflow runs one long --watch session and relies on
  // --max-minutes to end it before the job is killed, so that the post-job
  // cache save still runs. A default other than 0 here would silently cut
  // local `npm run watch` sessions short.
  it('leaves the watch session unbounded unless --max-minutes is given', () => {
    expect(buildConfig([], {}).maxMinutes).toBe(0);
    expect(buildConfig([], { ROOTS_WATCH_MAX_MINUTES: '' }).maxMinutes).toBe(0);
  });

  it('reads the interval and session length used by the workflow', () => {
    const config = buildConfig(['--watch', '--max-minutes', '55'], { ROOTS_WATCH_INTERVAL: '5' });
    expect(config.watch).toBe(true);
    expect(config.intervalMinutes).toBe(5);
    expect(config.maxMinutes).toBe(55);
  });

  it('prefers a CLI flag over both env and default', () => {
    const config = buildConfig(['--url', 'https://www.roots.com/ca/en/cli-product.html', '--sizes', 'S'], {
      ROOTS_WATCH_URL: 'https://www.roots.com/ca/en/other-product.html',
    });
    expect(config.url).toBe('https://www.roots.com/ca/en/cli-product.html');
    expect(config.sizes).toEqual(['S']);
  });
});
