import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FortnoxApiError, FortnoxClient } from '../client';

describe('FortnoxClient.getBinary', () => {
  beforeEach(() => {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', '');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('returns the raw bytes and response content type', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(Uint8Array.from([1, 2, 3]), {
        status: 200,
        headers: { 'Content-Type': 'application/pdf' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new FortnoxClient('https://fortnox.example.test/3');

    const result = await client.getBinary('access-token', '/archive/file-1');

    expect(Array.from(new Uint8Array(result.bytes))).toEqual([1, 2, 3]);
    expect(result.contentType).toBe('application/pdf');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://fortnox.example.test/3/archive/file-1',
      expect.objectContaining({
        headers: { Authorization: 'Bearer access-token' },
      }),
    );
  });

  it('preserves the HTTP status on binary request failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('missing', { status: 404, statusText: 'Not Found' }),
      ),
    );
    const client = new FortnoxClient('https://fortnox.example.test/3');

    const error = await client
      .getBinary('access-token', '/archive/file-1')
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(FortnoxApiError);
    expect(error).toMatchObject({ statusCode: 404, body: 'missing' });
  });
});
