import { afterEach, describe, expect, it } from 'vitest';
import {
  LUNDIFY_ACTIVATION_BASE_URL,
  buildLundifyActivationUrl,
  getBjornLundenActivationKey,
} from '../activation';

const ORIGINAL_KEY = process.env.BJORN_LUNDEN_ACTIVATION_KEY;

afterEach(() => {
  if (ORIGINAL_KEY === undefined) {
    delete process.env.BJORN_LUNDEN_ACTIVATION_KEY;
  } else {
    process.env.BJORN_LUNDEN_ACTIVATION_KEY = ORIGINAL_KEY;
  }
});

describe('getBjornLundenActivationKey', () => {
  it('returns null when the env var is unset or blank', () => {
    delete process.env.BJORN_LUNDEN_ACTIVATION_KEY;
    expect(getBjornLundenActivationKey()).toBeNull();
    process.env.BJORN_LUNDEN_ACTIVATION_KEY = '   ';
    expect(getBjornLundenActivationKey()).toBeNull();
  });

  it('returns the trimmed key when set', () => {
    process.env.BJORN_LUNDEN_ACTIVATION_KEY = ' 36b2bf61-0514-4825-a8a5-08cf151176f2 ';
    expect(getBjornLundenActivationKey()).toBe('36b2bf61-0514-4825-a8a5-08cf151176f2');
  });
});

describe('buildLundifyActivationUrl', () => {
  const KEY = '36b2bf61-0514-4825-a8a5-08cf151176f2';
  const CALLBACK = 'https://app.accounted.se/api/extensions/ext/arcim-migration/callback';

  it('follows BL: /activate-integration/{key}/{encodedRedirectUrl}?extra={state}', () => {
    const url = buildLundifyActivationUrl(KEY, CALLBACK, 'state-abc_123');
    expect(url).toBe(
      `${LUNDIFY_ACTIVATION_BASE_URL}/${KEY}/${encodeURIComponent(CALLBACK)}?extra=state-abc_123`,
    );
  });

  it('encodes the redirect URL as ONE path segment so its slashes do not split the path', () => {
    const url = new URL(buildLundifyActivationUrl(KEY, CALLBACK, 's'));
    const segments = url.pathname.split('/').filter(Boolean);
    expect(segments).toEqual(['activate-integration', KEY, encodeURIComponent(CALLBACK)]);
    expect(decodeURIComponent(segments[2]!)).toBe(CALLBACK);
  });

  it('percent-encodes a state that carries URL-significant characters', () => {
    const state = 'a+b&c=d/e';
    const url = new URL(buildLundifyActivationUrl(KEY, CALLBACK, state));
    expect(url.searchParams.get('extra')).toBe(state);
    expect(url.search).not.toContain('&c=');
  });
});
