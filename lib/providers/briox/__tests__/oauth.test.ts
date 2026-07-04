import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { exchangeBrioxCode, refreshBrioxToken } from '../oauth';
import { BrioxApiError } from '../client';

/**
 * Guards the token-exchange contract against the Briox swagger:
 *   POST /token?clientid={accountId}&token={applicationToken}
 *   POST /tokenrefresh?refreshtoken={refreshToken}&token={currentAccessToken}
 *
 * The refresh test pins the exact param mapping: the original implementation
 * sent the refresh token for BOTH params (and took the account id as an
 * unused first argument), which Briox rejects.
 */

function tokenResponse(over: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      data: {
        client_id: '35649125',
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        expire_date: '2026-06-10 12:00:00',
        // Swagger declares expire_timestamp as a STRING
        expire_timestamp: String(Math.floor(Date.now() / 1000) + 7200),
        ...over,
      },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

describe('briox oauth', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('exchange POSTs /token?clientid={accountId}&token={applicationToken}', async () => {
    fetchSpy.mockResolvedValueOnce(tokenResponse());

    const result = await exchangeBrioxCode('35649125', 'app-token-åäö');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe(
      'https://api-se.briox.services/v2/token?clientid=35649125&token=app-token-%C3%A5%C3%A4%C3%B6',
    );
    expect((init as RequestInit).method).toBe('POST');
    expect(result.access_token).toBe('access-1');
    expect(result.refresh_token).toBe('refresh-1');
  });

  it('refresh POSTs /tokenrefresh?refreshtoken={refreshToken}&token={currentAccessToken}', async () => {
    fetchSpy.mockResolvedValueOnce(
      tokenResponse({ access_token: 'access-2', refresh_token: 'refresh-2' }),
    );

    const result = await refreshBrioxToken('refresh-1', 'expired-access-1');

    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe(
      'https://api-se.briox.services/v2/tokenrefresh?refreshtoken=refresh-1&token=expired-access-1',
    );
    expect((init as RequestInit).method).toBe('POST');
    // Briox rotates both tokens: the new pair must be surfaced so the
    // caller persists the rotated refresh token.
    expect(result.access_token).toBe('access-2');
    expect(result.refresh_token).toBe('refresh-2');
  });

  it('derives expires_in from a string expire_timestamp', async () => {
    const now = Math.floor(Date.now() / 1000);
    fetchSpy.mockResolvedValueOnce(tokenResponse({ expire_timestamp: String(now + 1800) }));

    const result = await exchangeBrioxCode('1', 't');

    expect(result.expires_in).toBeGreaterThan(1700);
    expect(result.expires_in).toBeLessThanOrEqual(1800);
  });

  it('falls back to 3600 when expire_timestamp is in the past or unparseable', async () => {
    const now = Math.floor(Date.now() / 1000);

    fetchSpy.mockResolvedValueOnce(tokenResponse({ expire_timestamp: String(now - 60) }));
    expect((await exchangeBrioxCode('1', 't')).expires_in).toBe(3600);

    fetchSpy.mockResolvedValueOnce(tokenResponse({ expire_timestamp: 'not-a-number' }));
    expect((await exchangeBrioxCode('1', 't')).expires_in).toBe(3600);
  });

  it('exchange throws BrioxApiError carrying the HTTP status on rejection', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));

    const err = await exchangeBrioxCode('1', 'wrong-token').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BrioxApiError);
    expect((err as BrioxApiError).statusCode).toBe(401);
  });

  it('refresh throws BrioxApiError carrying the HTTP status on rejection', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('Bad request', { status: 400 }));

    const err = await refreshBrioxToken('r', 'a').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BrioxApiError);
    expect((err as BrioxApiError).statusCode).toBe(400);
  });
});
