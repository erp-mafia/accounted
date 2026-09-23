import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loginWint, refreshWintToken, jwtExpiresInSeconds, WintLoginRejectedError } from '../oauth';
import { WintApiError } from '../client';

function makeJwt(payload: Record<string, unknown>): string {
  const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64({ alg: 'HS256' })}.${b64(payload)}.signature`;
}

function authResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      State: 'Success',
      AuthTokens: { AccessToken: makeJwt({ exp: Math.floor(Date.now() / 1000) + 900 }), RefreshToken: 'refresh-1' },
      ...overrides,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

describe('WINT auth', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  describe('loginWint', () => {
    it('posts Mail/Password to /api/Auth/jwt and returns the token pair', async () => {
      fetchSpy.mockResolvedValueOnce(authResponse());

      const tokens = await loginWint('user@example.se', 'hemligt');

      const [url, init] = fetchSpy.mock.calls[0];
      expect(String(url)).toContain('/api/Auth/jwt');
      expect(JSON.parse((init as RequestInit).body as string)).toEqual({
        Mail: 'user@example.se',
        Password: 'hemligt',
      });
      expect(tokens.refresh_token).toBe('refresh-1');
      expect(tokens.token_type).toBe('Bearer');
      expect(tokens.expires_in).toBeGreaterThan(800);
    });

    it('throws WintLoginRejectedError on a definitive LoginState string', async () => {
      fetchSpy.mockResolvedValueOnce(authResponse({ State: 'WrongUsernameOrPassword', AuthTokens: null }));

      const err = await loginWint('user@example.se', 'fel').catch((e: unknown) => e);

      expect(err).toBeInstanceOf(WintLoginRejectedError);
      expect((err as WintLoginRejectedError).state).toBe('WrongUsernameOrPassword');
    });

    it('normalizes ordinal LoginState values (7 -> ForceLoginWithBankId)', async () => {
      fetchSpy.mockResolvedValueOnce(authResponse({ State: 7, AuthTokens: null }));

      const err = await loginWint('user@example.se', 'x').catch((e: unknown) => e);

      expect(err).toBeInstanceOf(WintLoginRejectedError);
      expect((err as WintLoginRejectedError).state).toBe('ForceLoginWithBankId');
    });

    it('carries the HTTP status on auth-endpoint errors', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('bad request', { status: 400 }));

      const err = await loginWint('user@example.se', 'x').catch((e: unknown) => e);

      expect(err).toBeInstanceOf(WintApiError);
      expect((err as WintApiError).statusCode).toBe(400);
    });

    it('fails cleanly when Success carries no access token', async () => {
      fetchSpy.mockResolvedValueOnce(authResponse({ AuthTokens: { AccessToken: null, RefreshToken: null } }));

      const err = await loginWint('user@example.se', 'x').catch((e: unknown) => e);

      expect(err).toBeInstanceOf(WintApiError);
      expect((err as WintApiError).message).toContain('incomplete token pair');
    });

    it('rejects a Success response missing the refresh token (unrefreshable consent)', async () => {
      const jwt = makeJwt({ exp: Math.floor(Date.now() / 1000) + 900 });
      fetchSpy.mockResolvedValueOnce(authResponse({ AuthTokens: { AccessToken: jwt, RefreshToken: null } }));

      const err = await loginWint('user@example.se', 'x').catch((e: unknown) => e);

      expect(err).toBeInstanceOf(WintApiError);
      expect((err as WintApiError).message).toContain('incomplete token pair');
    });

    it('rejects an unrecognized LoginState instead of assuming success', async () => {
      fetchSpy.mockResolvedValueOnce(authResponse({ State: 'SomethingNewFromWint' }));

      const err = await loginWint('user@example.se', 'x').catch((e: unknown) => e);

      expect(err).toBeInstanceOf(WintLoginRejectedError);
      expect((err as WintLoginRejectedError).state).toBe('SomethingNewFromWint');
    });
  });

  describe('refreshWintToken', () => {
    it('posts the refresh token as a bare JSON string and returns the rotated pair', async () => {
      fetchSpy.mockResolvedValueOnce(authResponse({ AuthTokens: { AccessToken: makeJwt({ exp: Math.floor(Date.now() / 1000) + 600 }), RefreshToken: 'refresh-2' } }));

      const tokens = await refreshWintToken('refresh-1');

      const [url, init] = fetchSpy.mock.calls[0];
      expect(String(url)).toContain('/api/Auth/refresh');
      // The swagger types the request body as a plain string.
      expect((init as RequestInit).body).toBe('"refresh-1"');
      expect(tokens.refresh_token).toBe('refresh-2');
    });
  });

  describe('jwtExpiresInSeconds', () => {
    it('reads exp from the JWT payload', () => {
      const now = 1_700_000_000_000;
      const token = makeJwt({ exp: 1_700_000_000 + 1200 });
      expect(jwtExpiresInSeconds(token, now)).toBe(1200);
    });

    it('falls back to 15 minutes for opaque tokens', () => {
      expect(jwtExpiresInSeconds('not-a-jwt')).toBe(900);
    });

    it('falls back to 15 minutes for an already-expired exp', () => {
      const now = 1_700_000_000_000;
      const token = makeJwt({ exp: 1_700_000_000 - 60 });
      expect(jwtExpiresInSeconds(token, now)).toBe(900);
    });
  });
});
