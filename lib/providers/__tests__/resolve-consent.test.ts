import { describe, it, expect, vi, beforeEach } from 'vitest';
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

import { createServiceClient } from '@/lib/supabase/server';
import { refreshBrioxToken } from '@/lib/providers/briox/oauth';
import { refreshFortnoxToken } from '@/lib/providers/fortnox/oauth';
import { resolveConsent } from '../resolve-consent';
import { ProviderCallError } from '../with-provider-call';

const consentRow = { id: 'c1', company_id: 'co1', provider: 'briox', status: 1 };

const expiredTokens = {
  access_token: 'old-access',
  refresh_token: 'old-refresh',
  token_expires_at: '2020-01-01T00:00:00.000Z',
  provider_company_id: 'acct-1',
};

describe('resolveConsent: Briox token refresh concurrency', () => {
  let mock: ReturnType<typeof createQueuedMockSupabase>;

  beforeEach(() => {
    vi.clearAllMocks();
    mock = createQueuedMockSupabase();
    vi.mocked(createServiceClient).mockReturnValue(mock.supabase as never);
    vi.mocked(refreshBrioxToken).mockResolvedValue({
      access_token: 'new-access',
      refresh_token: 'new-refresh',
      token_type: 'Bearer',
      expires_in: 3600,
    });
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
      new Error(
        'Fortnox token refresh failed: 401 {"error":"error_missing_license","error_description":"The client credentials are invalid"}',
      ),
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

    // A plain expired/revoked grant IS revivable by reconnecting: it must not
    // be mis-mapped to the license code.
    vi.mocked(refreshFortnoxToken).mockRejectedValueOnce(
      new Error('Fortnox token refresh failed: 400 {"error":"invalid_grant"}'),
    );

    const err = await resolveConsent('co1', 'c2').catch((e) => e);

    expect(err).toBeInstanceOf(ProviderCallError);
    expect(err.code).toBe('PROVIDER_AUTH_EXPIRED');
    expect(err.provider).toBe('fortnox');
  });
});
