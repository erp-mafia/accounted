import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createQueuedMockSupabase } from '@/tests/helpers';

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}));

vi.mock('@/lib/providers/briox/oauth', () => ({
  refreshBrioxToken: vi.fn(),
}));

vi.mock('@/lib/providers/fortnox/oauth', () => ({
  refreshFortnoxToken: vi.fn(),
}));

vi.mock('@/lib/providers/wint/oauth', () => ({
  refreshWintToken: vi.fn(),
}));

import { createServiceClient } from '@/lib/supabase/server';
import { refreshBrioxToken } from '@/lib/providers/briox/oauth';
import { refreshFortnoxToken } from '@/lib/providers/fortnox/oauth';
import { refreshWintToken } from '@/lib/providers/wint/oauth';
import { resolveConsent } from '../resolve-consent';
import { FortnoxOAuthError } from '../fortnox/oauth-error';
import { ProviderCallError } from '../with-provider-call';
import { currentExecutionBudget, ExecutionBudgetExceeded, withExecutionDeadline } from '@/lib/http/execution-budget';
import { TimeoutError } from '@/lib/http/fetch-with-timeout';
import { openConsentToken, sealConsentToken } from '../consent-tokens';

/** An update payload with its sealed tokens opened. */
function opened(update: unknown[] | undefined): Record<string, unknown> {
  const patch = { ...(update?.[0] as Record<string, unknown>) };
  for (const column of ['access_token', 'refresh_token']) {
    const value = patch[column];
    if (typeof value === 'string') {
      expect(value.startsWith('pct1:')).toBe(true);
      patch[column] = openConsentToken(value);
    }
  }
  return patch;
}

const consentRow = { id: 'c1', company_id: 'co1', provider: 'briox', status: 1 };

const expiredTokens = {
  credential_revision: 'old-revision',
  access_token: 'old-access',
  refresh_token: 'old-refresh',
  token_expires_at: '2020-01-01T00:00:00.000Z',
  provider_company_id: 'acct-1',
};

describe('resolveConsent: Briox token refresh concurrency', () => {
  let mock: ReturnType<typeof createQueuedMockSupabase>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('PERSONNUMMER_ENCRYPTION_KEY', 'test-personnummer-key');
    mock = createQueuedMockSupabase();
    vi.mocked(createServiceClient).mockReturnValue(mock.supabase as never);
    vi.mocked(refreshBrioxToken).mockResolvedValue({
      access_token: 'new-access',
      refresh_token: 'new-refresh',
      token_type: 'Bearer',
      expires_in: 3600,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('defers without rotating a token when the refresh and persistence reserve cannot fit', async () => {
    mock.enqueue({ data: [consentRow] });
    mock.enqueue({ data: [expiredTokens] });
    await expect(withExecutionDeadline(Date.now() + 14_000, 'credentials', () => resolveConsent('co1', 'c1')))
      .rejects.toBeInstanceOf(ExecutionBudgetExceeded);
    expect(refreshBrioxToken).not.toHaveBeenCalled();
    expect(mock.findCall('provider_consent_tokens', 'update')).toBeUndefined();
  });

  it('saves a rotated pair within the parent budget after the refresh scope has finished', async () => {
    vi.useFakeTimers();
    const deadline = Date.now() + 20_000;
    mock.enqueue({ data: [consentRow] });
    mock.enqueue({ data: [expiredTokens] });
    mock.enqueue({ data: [{ consent_id: 'c1' }] });
    vi.mocked(refreshBrioxToken).mockImplementationOnce(async () => {
      expect(currentExecutionBudget()?.deadline).toBe(deadline - 5000);
      vi.setSystemTime(Date.now() + 9500);
      return { access_token: 'rotated', refresh_token: 'rotated-refresh', token_type: 'Bearer', expires_in: 3600 };
    });
    const result = await withExecutionDeadline(deadline, 'credentials', () => resolveConsent('co1', 'c1'));
    expect(result.accessToken).toBe('rotated');
    expect(opened(mock.findCall('provider_consent_tokens', 'update'))).toMatchObject({ refresh_token: 'rotated-refresh' });
  });

  it('does not turn a slow refresh into an expired-credentials instruction', async () => {
    mock.enqueue({ data: [consentRow] });
    mock.enqueue({ data: [expiredTokens] });
    const timeout = new TimeoutError('refresh timed out');
    vi.mocked(refreshBrioxToken).mockRejectedValueOnce(timeout);
    await expect(withExecutionDeadline(Date.now() + 20_000, 'credentials', () => resolveConsent('co1', 'c1')))
      .rejects.toBe(timeout);
  });

  it('returns the stored token without refreshing when not expired', async () => {
    mock.enqueue({ data: [consentRow] });
    mock.enqueue({
      data: [{ ...expiredTokens, token_expires_at: new Date(Date.now() + 3_600_000).toISOString() }],
    });

    const result = await resolveConsent('co1', 'c1');

    expect(result.accessToken).toBe('old-access');
    expect(refreshBrioxToken).not.toHaveBeenCalled();
  });

  describe('a token the provider refused (B11)', () => {
    // Stamped valid for ten more minutes: our clock says alive, Fortnox said 401.
    const liveByClock = { ...expiredTokens, token_expires_at: new Date(Date.now() + 600_000).toISOString() };
    const fortnoxConsent = { ...consentRow, provider: 'fortnox' };

    it('refreshes the refused token although its stamped expiry has not passed', async () => {
      mock.enqueue({ data: [fortnoxConsent] });
      mock.enqueue({ data: [liveByClock] });
      mock.enqueue({ data: [{ consent_id: 'c1', credential_revision: 'new-revision' }] });
      vi.mocked(refreshFortnoxToken).mockResolvedValueOnce({ access_token: 'fresh', refresh_token: 'fresh-refresh', token_type: 'Bearer', expires_in: 3600 });

      await expect(resolveConsent('co1', 'c1', { rejectedAccessToken: 'old-access' }))
        .resolves.toMatchObject({ accessToken: 'fresh', credentialRevision: 'new-revision' });
      expect(refreshFortnoxToken).toHaveBeenCalledOnce();
    });

    it('serves a token another request rotated since, without refreshing again', async () => {
      mock.enqueue({ data: [fortnoxConsent] });
      mock.enqueue({ data: [{ ...liveByClock, access_token: 'rotated-elsewhere' }] });

      await expect(resolveConsent('co1', 'c1', { rejectedAccessToken: 'old-access' }))
        .resolves.toMatchObject({ accessToken: 'rotated-elsewhere' });
      expect(refreshFortnoxToken).not.toHaveBeenCalled();
    });

    it('answers a refused token whose refresh grant is gone with PROVIDER_AUTH_EXPIRED', async () => {
      mock.enqueue({ data: [fortnoxConsent] });
      mock.enqueue({ data: [liveByClock] });
      mock.enqueue({ data: [liveByClock] }); // revision reconciliation: nobody renewed it
      vi.mocked(refreshFortnoxToken).mockRejectedValueOnce(new FortnoxOAuthError('refresh', 400, 'invalid_grant'));

      await expect(resolveConsent('co1', 'c1', { rejectedAccessToken: 'old-access' }))
        .rejects.toMatchObject({ code: 'PROVIDER_AUTH_EXPIRED', providerCode: 'invalid_grant' });
    });

    it('leaves a live token alone when no refusal is named', async () => {
      mock.enqueue({ data: [fortnoxConsent] });
      mock.enqueue({ data: [liveByClock] });

      await expect(resolveConsent('co1', 'c1')).resolves.toMatchObject({ accessToken: 'old-access' });
      expect(refreshFortnoxToken).not.toHaveBeenCalled();
    });
  });

  it('persists the rotated pair when the guarded update wins the race', async () => {
    mock.enqueue({ data: [consentRow] }); // consent lookup
    mock.enqueue({ data: [expiredTokens] }); // expired token row
    mock.enqueue({ data: [{ consent_id: 'c1' }] }); // guarded update matched 1 row (PK is consent_id, not id)

    const result = await resolveConsent('co1', 'c1');

    expect(result.accessToken).toBe('new-access');
    expect(refreshBrioxToken).toHaveBeenCalledTimes(1);
    expect(refreshBrioxToken).toHaveBeenCalledWith('old-refresh', 'old-access');
  });

  it('adopts the concurrent winner\'s tokens when the guarded update matches 0 rows (lost race)', async () => {
    mock.enqueue({ data: [consentRow] }); // consent lookup
    mock.enqueue({ data: [expiredTokens] }); // expired token row (both requests read this)
    mock.enqueue({ data: [] }); // guarded update: another request already rotated
    mock.enqueue({
      // re-read returns the winner's freshly persisted pair
      data: [
        {
          access_token: 'winner-access',
          refresh_token: 'winner-refresh',
          token_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          provider_company_id: 'acct-1',
        },
      ],
    });

    const result = await resolveConsent('co1', 'c1');

    // Must use the persisted fresh tokens, NOT call Briox /tokenrefresh again:
    // a second rotation would invalidate the winner's pair.
    expect(result.accessToken).toBe('winner-access');
    expect(result.providerCompanyId).toBe('acct-1');
    expect(refreshBrioxToken).toHaveBeenCalledTimes(1);
  });

  it('fails loudly with re-enter guidance when the rotated pair cannot be persisted', async () => {
    mock.enqueue({ data: [consentRow] }); // consent lookup
    mock.enqueue({ data: [expiredTokens] }); // expired token row
    mock.enqueue({ data: null, error: { message: 'connection reset' } }); // update failed

    // Briox has already rotated the tokens at this point: the stored pair is
    // dead, so the user must reconnect with fresh credentials.
    await expect(resolveConsent('co1', 'c1')).rejects.toMatchObject({
      status: 500,
      message: expect.stringContaining('re-enter the credentials'),
    });
  });

  it('rethrows a dead refresh token as PROVIDER_AUTH_EXPIRED so callers prompt reconnect', async () => {
    mock.enqueue({ data: [consentRow] }); // consent lookup
    mock.enqueue({ data: [expiredTokens] }); // expired token row

    // Mirrors Fortnox's `400 invalid_grant`: the raw helper throws a plain
    // Error whose status lives only in the message string. resolveConsent must
    // still classify it as an expired connection, not let it fall through to a
    // generic 500 at the route.
    vi.mocked(refreshBrioxToken).mockRejectedValueOnce(
      new Error('Briox token refresh failed: 400 {"error":"invalid_grant"}'),
    );

    const err = await resolveConsent('co1', 'c1').catch((e) => e);

    expect(err).toBeInstanceOf(ProviderCallError);
    expect(err.code).toBe('PROVIDER_AUTH_EXPIRED');
    expect(err.provider).toBe('briox');
  });

  it('maps Fortnox error_missing_license to PROVIDER_LICENSE_MISSING (not a revivable reconnect)', async () => {
    const fortnoxConsent = { id: 'c2', company_id: 'co1', provider: 'fortnox', status: 1 };
    mock.enqueue({ data: [fortnoxConsent] }); // consent lookup
    mock.enqueue({ data: [expiredTokens] }); // expired token row

    // Fortnox answers the token endpoint with error_missing_license when the
    // customer's integration license has lapsed. Re-auth can't revive it: the
    // license must be re-ordered first: so it gets its own code rather than the
    // generic "reconnect" PROVIDER_AUTH_EXPIRED.
    vi.mocked(refreshFortnoxToken).mockRejectedValueOnce(
      new FortnoxOAuthError('refresh', 401, 'error_missing_license'),
    );

    const err = await resolveConsent('co1', 'c2').catch((e) => e);

    expect(err).toBeInstanceOf(ProviderCallError);
    expect(err.code).toBe('PROVIDER_LICENSE_MISSING');
    expect(err.provider).toBe('fortnox');
  });

  it('keeps a Fortnox invalid_grant as PROVIDER_AUTH_EXPIRED (revivable by reconnect)', async () => {
    const fortnoxConsent = { id: 'c2', company_id: 'co1', provider: 'fortnox', status: 1 };
    mock.enqueue({ data: [fortnoxConsent] }); // consent lookup
    mock.enqueue({ data: [expiredTokens] }); // expired token row

    mock.enqueue({ data: [expiredTokens] }); // revision reconciliation

    // A plain expired/revoked grant IS revivable by reconnecting: it must not
    // be mis-mapped to the license code.
    vi.mocked(refreshFortnoxToken).mockRejectedValueOnce(
      new FortnoxOAuthError('refresh', 400, 'invalid_grant'),
    );

    const err = await resolveConsent('co1', 'c2').catch((e) => e);

    expect(err).toBeInstanceOf(ProviderCallError);
    expect(err.code).toBe('PROVIDER_AUTH_EXPIRED');
    expect(err.provider).toBe('fortnox');
  });

  it.each([
    [new FortnoxOAuthError('refresh', 429, 'rate_limited', 7200), 'PROVIDER_RATE_LIMITED'],
    [new FortnoxOAuthError('refresh', 503), 'PROVIDER_UPSTREAM_ERROR'],
    [new FortnoxOAuthError('refresh', 401, 'invalid_client'), 'PROVIDER_CONFIGURATION_ERROR'],
    [new TypeError('fetch failed'), 'PROVIDER_UNREACHABLE'],
    [new Error('unexpected response'), 'PROVIDER_UPSTREAM_ERROR'],
  ])('does not turn temporary or operator failures into expired authorization', async (failure, code) => {
    mock.enqueue({ data: [{ ...consentRow, provider: 'fortnox' }] });
    mock.enqueue({ data: [expiredTokens] });
    vi.mocked(refreshFortnoxToken).mockRejectedValueOnce(failure);
    await expect(resolveConsent('co1', 'c1')).rejects.toMatchObject({ code, credentialRevision: 'old-revision' });
    expect(mock.findCall('provider_consent_tokens', 'update')).toBeUndefined();
  });

  it('adopts renewed credentials after a losing invalid_grant without refreshing again', async () => {
    mock.enqueue({ data: [{ ...consentRow, provider: 'fortnox' }] });
    mock.enqueue({ data: [expiredTokens] });
    mock.enqueue({ data: [{ ...expiredTokens, access_token: 'renewed', credential_revision: 'new-revision' }] });
    vi.mocked(refreshFortnoxToken).mockRejectedValueOnce(new FortnoxOAuthError('refresh', 400, 'invalid_grant'));
    await expect(resolveConsent('co1', 'c1')).resolves.toMatchObject({ accessToken: 'renewed', credentialRevision: 'new-revision' });
    expect(refreshFortnoxToken).toHaveBeenCalledOnce();
  });

  it('requires reconnection when an expired Fortnox token has no refresh token', async () => {
    mock.enqueue({ data: [{ ...consentRow, provider: 'fortnox' }] });
    mock.enqueue({ data: [{ ...expiredTokens, refresh_token: null }] });
    await expect(resolveConsent('co1', 'c1')).rejects.toMatchObject({
      code: 'PROVIDER_AUTH_EXPIRED', providerCode: 'refresh_token_missing', credentialRevision: 'old-revision',
    });
    expect(refreshFortnoxToken).not.toHaveBeenCalled();
  });

  it('preserves definitive failure evidence when credential reconciliation cannot read the row', async () => {
    mock.enqueue({ data: [{ ...consentRow, provider: 'fortnox' }] });
    mock.enqueue({ data: [expiredTokens] });
    mock.enqueue({ error: { message: 'connection reset' } });
    vi.mocked(refreshFortnoxToken).mockRejectedValueOnce(new FortnoxOAuthError('refresh', 400, 'invalid_grant'));
    await expect(resolveConsent('co1', 'c1')).rejects.toMatchObject({
      code: 'PROVIDER_AUTH_EXPIRED', providerCode: 'invalid_grant', credentialRevision: 'old-revision', status: 400,
    });
  });

  it.each(['fortnox', 'briox'])('persists rotated %s credentials before the revision migration is available', async provider => {
    const { credential_revision: _revision, ...legacyTokens } = expiredTokens;
    mock.enqueue({ data: [{ ...consentRow, provider }] });
    mock.enqueue({ data: [legacyTokens] });
    mock.enqueue({ data: [{ consent_id: 'c1' }] });
    if (provider === 'fortnox') vi.mocked(refreshFortnoxToken).mockResolvedValueOnce({ access_token: 'new-access', refresh_token: 'new-refresh', token_type: 'Bearer', expires_in: 3600 });
    await expect(resolveConsent('co1', 'c1')).resolves.toMatchObject({ accessToken: 'new-access' });
    expect(mock.findCalls('provider_consent_tokens', 'select')).toEqual([['*'], ['consent_id']]);
    expect(mock.findCalls('provider_consent_tokens', 'eq')).toContainEqual(['token_expires_at', legacyTokens.token_expires_at]);
    expect(mock.findCalls('provider_consent_tokens', 'eq').some(args => args[0] === 'credential_revision')).toBe(false);
    expect(opened(mock.findCall('provider_consent_tokens', 'update'))).toMatchObject({ refresh_token: 'new-refresh' });
  });

  it('returns the revision of the saved Fortnox token, not the expired snapshot', async () => {
    mock.enqueue({ data: [{ ...consentRow, provider: 'fortnox' }] });
    mock.enqueue({ data: [expiredTokens] });
    mock.enqueue({ data: [{ consent_id: 'c1', credential_revision: 'saved-revision' }] });
    vi.mocked(refreshFortnoxToken).mockResolvedValueOnce({ access_token: 'saved', refresh_token: 'saved-refresh', token_type: 'Bearer', expires_in: 3600 });
    await expect(resolveConsent('co1', 'c1')).resolves.toMatchObject({ accessToken: 'saved', credentialRevision: 'saved-revision' });
    expect(mock.findCalls('provider_consent_tokens', 'eq').find(args => args[0] === 'credential_revision')?.[1]).toBe('old-revision');
  });

  it('refreshes an expired WINT consent via refreshWintToken and persists the rotated pair', async () => {
    const wintConsent = { id: 'c3', company_id: 'co1', provider: 'wint', status: 1 };
    mock.enqueue({ data: [wintConsent] }); // consent lookup
    mock.enqueue({ data: [{ ...expiredTokens, provider_company_id: '4711' }] }); // expired token row
    mock.enqueue({ data: [{ consent_id: 'c3' }] }); // guarded update matched 1 row

    vi.mocked(refreshWintToken).mockResolvedValueOnce({
      access_token: 'wint-new-access',
      refresh_token: 'wint-new-refresh',
      token_type: 'Bearer',
      expires_in: 900,
    });

    const result = await resolveConsent('co1', 'c3');

    // WINT refresh takes only the refresh token (the body is the bare string)
    expect(refreshWintToken).toHaveBeenCalledWith('old-refresh');
    expect(result.accessToken).toBe('wint-new-access');
    expect(result.providerCompanyId).toBe('4711');
    // The rotated pair went through the guarded update, both tokens included
    const updateArgs = mock.findCall('provider_consent_tokens', 'update');
    expect(opened(updateArgs)).toMatchObject({
      access_token: 'wint-new-access',
      refresh_token: 'wint-new-refresh',
    });
  });

  it('maps a failed WINT refresh to PROVIDER_AUTH_EXPIRED so callers prompt reconnect', async () => {
    const wintConsent = { id: 'c3', company_id: 'co1', provider: 'wint', status: 1 };
    mock.enqueue({ data: [wintConsent] }); // consent lookup
    mock.enqueue({ data: [expiredTokens] }); // expired token row

    vi.mocked(refreshWintToken).mockRejectedValueOnce(
      new Error('WINT token refresh failed: 401'),
    );

    const err = await resolveConsent('co1', 'c3').catch((e) => e);

    expect(err).toBeInstanceOf(ProviderCallError);
    expect(err.code).toBe('PROVIDER_AUTH_EXPIRED');
    expect(err.provider).toBe('wint');
  });

  // accounted#58: the tokens were stored in plaintext. Every write now seals,
  // a sealed row is opened on read, and a legacy plaintext row is sealed in
  // place the first time it is served.
  describe('sealed token storage', () => {
    const live = { ...expiredTokens, token_expires_at: new Date(Date.now() + 3_600_000).toISOString() };

    it('opens a sealed row and serves it without writing', async () => {
      mock.enqueue({ data: [consentRow] });
      mock.enqueue({ data: [{ ...live, access_token: sealConsentToken('old-access'), refresh_token: sealConsentToken('old-refresh') }] });
      await expect(resolveConsent('co1', 'c1')).resolves.toMatchObject({ accessToken: 'old-access', credentialRevision: 'old-revision' });
      expect(mock.findCall('provider_consent_tokens', 'update')).toBeUndefined();
    });

    it('reseals a legacy plaintext row it serves, guarded on the revision, and hands out the new revision', async () => {
      mock.enqueue({ data: [consentRow] });
      mock.enqueue({ data: [live] });
      mock.enqueue({ data: [{ consent_id: 'c1', credential_revision: 'resealed-revision' }] });
      await expect(resolveConsent('co1', 'c1')).resolves.toMatchObject({ accessToken: 'old-access', credentialRevision: 'resealed-revision' });
      expect(opened(mock.findCall('provider_consent_tokens', 'update'))).toEqual({ access_token: 'old-access', refresh_token: 'old-refresh' });
      expect(mock.findCalls('provider_consent_tokens', 'eq')).toContainEqual(['credential_revision', 'old-revision']);
      expect(refreshBrioxToken).not.toHaveBeenCalled();
    });

    it('still serves a legacy row when the reseal fails', async () => {
      mock.enqueue({ data: [consentRow] });
      mock.enqueue({ data: [live] });
      mock.enqueue({ error: { message: 'connection reset' } });
      await expect(resolveConsent('co1', 'c1')).resolves.toMatchObject({ accessToken: 'old-access', credentialRevision: 'old-revision' });
    });

    it('reseals a legacy Bokio token, which never expires and so is never rewritten by a refresh', async () => {
      mock.enqueue({ data: [{ ...consentRow, provider: 'bokio' }] });
      mock.enqueue({ data: [{ credential_revision: 'old-revision', access_token: 'bokio-token', refresh_token: null, token_expires_at: null, provider_company_id: 'guid' }] });
      mock.enqueue({ data: [{ consent_id: 'c1', credential_revision: 'resealed-revision' }] });
      await expect(resolveConsent('co1', 'c1')).resolves.toMatchObject({ accessToken: 'bokio-token', providerCompanyId: 'guid' });
      expect(opened(mock.findCall('provider_consent_tokens', 'update'))).toEqual({ access_token: 'bokio-token' });
    });

    it('opens a sealed expired pair for the refresh and writes the rotated pair sealed', async () => {
      mock.enqueue({ data: [{ ...consentRow, provider: 'fortnox' }] });
      mock.enqueue({ data: [{ ...expiredTokens, access_token: sealConsentToken('old-access'), refresh_token: sealConsentToken('old-refresh') }] });
      mock.enqueue({ data: [{ consent_id: 'c1', credential_revision: 'saved-revision' }] });
      vi.mocked(refreshFortnoxToken).mockResolvedValueOnce({ access_token: 'new-access', refresh_token: 'new-refresh', token_type: 'Bearer', expires_in: 3600 });
      await expect(resolveConsent('co1', 'c1')).resolves.toMatchObject({ accessToken: 'new-access', credentialRevision: 'saved-revision' });
      expect(vi.mocked(refreshFortnoxToken).mock.calls[0]?.[1]).toBe('old-refresh');
      const patch = mock.findCall('provider_consent_tokens', 'update')?.[0] as Record<string, string>;
      expect(JSON.stringify(patch)).not.toContain('new-access');
      expect(JSON.stringify(patch)).not.toContain('new-refresh');
      expect(opened([patch])).toMatchObject({ access_token: 'new-access', refresh_token: 'new-refresh' });
    });

    it('opens the sealed pair a concurrent refresh won with', async () => {
      mock.enqueue({ data: [consentRow] });
      mock.enqueue({ data: [expiredTokens] });
      mock.enqueue({ data: [] });
      mock.enqueue({ data: [{ ...live, access_token: sealConsentToken('winner-access'), refresh_token: sealConsentToken('winner-refresh') }] });
      await expect(resolveConsent('co1', 'c1')).resolves.toMatchObject({ accessToken: 'winner-access' });
    });
  });
});
