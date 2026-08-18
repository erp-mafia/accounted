import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BokioApiError,
  BokioClient,
  BokioResponseError,
  normalizeBokioAccessToken,
} from '../client';
import { BOKIO_BASE_URL } from '../config';

const COMPANY_ID = '9b408943-7a1e-47ac-85a7-ac52b2c210d3';

describe('BokioClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('targets the official Bokio API v1 base URL', () => {
    expect(BOKIO_BASE_URL).toBe('https://api.bokio.se/v1');
  });

  it('uses the documented v1 company-information path and unwraps its response', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({
        companyInformation: {
          id: COMPANY_ID,
          name: 'Testbolaget AB',
          organizationNumber: '556677-8899',
        },
      }),
    );

    const result = await new BokioClient().getCompany<Record<string, unknown>>(
      'integration-token',
      COMPANY_ID,
    );

    expect(result).toMatchObject({
      id: COMPANY_ID,
      organizationNumber: '556677-8899',
    });
    expect(fetch).toHaveBeenCalledWith(
      `${BOKIO_BASE_URL}/companies/${COMPANY_ID}/company-information`,
      expect.objectContaining({
        headers: {
          Accept: 'application/json',
          Authorization: 'Bearer integration-token',
        },
      }),
    );
  });

  it('normalizes a pasted Bearer header and surrounding whitespace once', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({ companyInformation: { id: COMPANY_ID } }),
    );

    await new BokioClient().getCompany('  bEaReR copied-token==\r\n', `  ${COMPANY_ID}  `);

    const [, init] = vi.mocked(fetch).mock.calls[0]!;
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      'Bearer copied-token==',
    );
  });

  it('returns null for a company-information 404', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('', { status: 404, statusText: 'Not Found' }),
    );

    await expect(
      new BokioClient().getCompany('integration-token', COMPANY_ID),
    ).resolves.toBeNull();
  });

  it.each([400, 401, 403])(
    'preserves a company-information HTTP %i as a Bokio API error',
    async (statusCode) => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response('', { status: statusCode, statusText: 'Request failed' }),
      );

      const error = await new BokioClient()
        .getCompany('integration-token', COMPANY_ID)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(BokioApiError);
      expect((error as BokioApiError).statusCode).toBe(statusCode);
    },
  );

  it('keeps an invalid response envelope distinct from a company 404', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ name: 'Unexpected shape' }));

    await expect(
      new BokioClient().getCompany('integration-token', COMPANY_ID),
    ).rejects.toBeInstanceOf(BokioResponseError);
  });
});

describe('normalizeBokioAccessToken', () => {
  it.each([
    [' raw-token ', 'raw-token'],
    ['Bearer copied-token', 'copied-token'],
    [' bearer\tsecondary-token\n', 'secondary-token'],
  ])('normalizes %j', (input, expected) => {
    expect(normalizeBokioAccessToken(input)).toBe(expected);
  });

  it('does not remove internal token characters', () => {
    expect(normalizeBokioAccessToken('token with spaces')).toBe('token with spaces');
  });
});
