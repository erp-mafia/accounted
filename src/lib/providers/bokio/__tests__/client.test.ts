import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BokioApiError,
  BokioClient,
  BokioResponseError,
  bokioErrorCode,
  isBokioPricePlanError,
  normalizeBokioAccessToken,
  unwrapBokioCompanyInformation,
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

  it('accepts the flat company object the live v1 API returns (no envelope)', async () => {
    // Observed on api.bokio.se/v1 in production 2026-08-20: a 200 whose body
    // is the company itself, not `{ companyInformation }` as the spec says.
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({
        id: COMPANY_ID,
        name: 'Testbolaget AB',
        companyType: 'limitedCompany',
        organizationNumber: '5566778899',
        email: 'ekonomi@example.se',
        hasBBA: false,
        address: { line1: 'Testgatan 1', city: 'STOCKHOLM', postalCode: '111 23', country: 'SE' },
      }),
    );

    const result = await new BokioClient().getCompany<Record<string, unknown>>(
      'integration-token',
      COMPANY_ID,
    );

    expect(result).toMatchObject({
      id: COMPANY_ID,
      name: 'Testbolaget AB',
      organizationNumber: '5566778899',
    });
  });

  it.each([
    ['empty object', {}],
    ['null envelope', { companyInformation: null }],
    ['empty envelope', { companyInformation: {} }],
    ['envelope without identifying fields', { companyInformation: { foo: 'bar' } }],
    ['array body', []],
    ['paged list body', { items: [], totalItems: 0, totalPages: 0, currentPage: 1 }],
  ])('keeps an unusable response body (%s) distinct from a company 404', async (_label, body) => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(body));

    await expect(
      new BokioClient().getCompany('integration-token', COMPANY_ID),
    ).rejects.toBeInstanceOf(BokioResponseError);
  });
});

describe('unwrapBokioCompanyInformation', () => {
  it('prefers the documented envelope when present', () => {
    expect(
      unwrapBokioCompanyInformation({ companyInformation: { id: COMPANY_ID }, id: 'outer' }),
    ).toEqual({ id: COMPANY_ID });
  });

  it('falls back to a flat company object', () => {
    expect(unwrapBokioCompanyInformation({ id: COMPANY_ID, name: 'Testbolaget AB' })).toEqual({
      id: COMPANY_ID,
      name: 'Testbolaget AB',
    });
  });

  it('does not fall back to outer fields when the envelope is malformed', () => {
    expect(
      unwrapBokioCompanyInformation({ companyInformation: { foo: 'bar' }, id: COMPANY_ID }),
    ).toBeNull();
    expect(
      unwrapBokioCompanyInformation({ companyInformation: {}, name: 'Outer AB' }),
    ).toBeNull();
  });

  it.each([
    null,
    'text',
    42,
    [],
    {},
    { companyInformation: 'nope' },
    { companyInformation: {} },
    { companyInformation: { foo: 'bar' } },
    { companyInformation: [{ id: COMPANY_ID }] },
    { foo: 'bar' },
  ])('returns null for %j', (body) => {
    expect(unwrapBokioCompanyInformation(body)).toBeNull();
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

  it('strips a NUL and other control characters from every string in the response body', async () => {
    // A NUL inside an invoice number made Postgres reject the insert, so the
    // invoice silently went missing from the import (2026-09-23).
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({ items: [{ invoiceNumber: 'B00CEDB7-00\u000002', note: 'rad 1\nrad 2\u0007' }] }),
    );

    const result = await new BokioClient().get<{ items: { invoiceNumber: string; note: string }[] }>('t', '/x');

    expect(result.items[0]).toEqual({ invoiceNumber: 'B00CEDB7-0002', note: 'rad 1\nrad 2' });
  });

  it('does not remove internal token characters', () => {
    expect(normalizeBokioAccessToken('token with spaces')).toBe('token with spaces');
  });
});

// Documented plan-refusal body (docs.bokio.se/docs/price-plan-requirements).
const PLAN_BODY_ERROR = JSON.stringify({
  error: 'price_plan_feature_required',
  message: 'This feature requires Integrations (API) or a Plus plan',
  details: { requiredFeature: 'PrivateApi', availableIn: ['Plus', 'Premium', 'Business'], isInTrial: false },
});
// Same refusal in the shape of Bokio's generic apiError schema (`code`).
const PLAN_BODY_CODE = JSON.stringify({
  code: 'price_plan_feature_required',
  message: 'This feature requires a plan with API access',
});

describe('isBokioPricePlanError', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('fetch', vi.fn());
  });

  it.each([
    ['the documented `error` field', PLAN_BODY_ERROR],
    ['the apiError `code` field', PLAN_BODY_CODE],
  ])('recognises a 403 plan refusal carried in %s', (_label, body) => {
    expect(isBokioPricePlanError(new BokioApiError('Bokio API error: 403', 403, body))).toBe(true);
  });

  it.each([
    ['a scope refusal', JSON.stringify({ code: 'forbidden', message: 'Missing scope' })],
    ['a non-JSON body', '<html>Forbidden</html>'],
    ['an empty body', ''],
    ['no body', undefined],
  ])('keeps a 403 with %s an ordinary refusal', (_label, body) => {
    expect(isBokioPricePlanError(new BokioApiError('Bokio API error: 403', 403, body))).toBe(false);
  });

  it('only counts a 403, never another status carrying the same string', () => {
    expect(isBokioPricePlanError(new BokioApiError('Bokio API error: 401', 401, PLAN_BODY_ERROR))).toBe(false);
    expect(isBokioPricePlanError(new BokioApiError('Bokio API error: 404', 404, PLAN_BODY_ERROR))).toBe(false);
  });

  it('ignores anything that is not a BokioApiError', () => {
    expect(isBokioPricePlanError(new Error('price_plan_feature_required'))).toBe(false);
    expect(isBokioPricePlanError(null)).toBe(false);
  });

  it('keeps the body of a 403 from the company probe so the refusal can be recognised', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(PLAN_BODY_ERROR, { status: 403, statusText: 'Forbidden' }),
    );

    const err: unknown = await new BokioClient()
      .getCompany('integration-token', COMPANY_ID)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BokioApiError);
    expect(isBokioPricePlanError(err)).toBe(true);
    // A 403 is a verdict, not a transient: one request, no retries.
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('bokioErrorCode', () => {
  it('reads the `error` field, then the `code` field', () => {
    expect(bokioErrorCode(PLAN_BODY_ERROR)).toBe('price_plan_feature_required');
    expect(bokioErrorCode(PLAN_BODY_CODE)).toBe('price_plan_feature_required');
  });

  it.each([
    ['no body', undefined],
    ['an empty body', ''],
    ['a non-JSON body', 'Forbidden'],
    ['a JSON array', '[]'],
    ['a body without a code', JSON.stringify({ message: 'Forbidden' })],
    ['a code that is free text', JSON.stringify({ error: 'Token abc123 is not valid for company x' })],
    ['a code that is not a string', JSON.stringify({ code: 403 })],
  ])('returns null for %s, so nothing but a code ever reaches a log', (_label, body) => {
    expect(bokioErrorCode(body)).toBeNull();
  });
});
