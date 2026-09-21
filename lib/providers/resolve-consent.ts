import { checkExecutionBudget, currentExecutionBudget, ExecutionBudgetExceeded, queryInExecutionBudget, withExecutionDeadline } from '@/lib/http/execution-budget';
import { OAUTH_TIMEOUT_MS, isTimeoutError } from '@/lib/http/fetch-with-timeout';
import { createServiceClient } from '@/lib/supabase/server';
import type { TokenResponse } from './types';
import { getOAuthConfig } from './oauth-config';
import { refreshFortnoxToken } from './fortnox/oauth';
import { refreshVismaToken } from './visma/oauth';
import { refreshBrioxToken } from './briox/oauth';
import { refreshBjornLundenToken } from './bjornlunden/oauth';
import { refreshWintToken } from './wint/oauth';
import { ProviderCallError, classifyProviderError, isMissingLicenseError } from './with-provider-call';
import { FortnoxOAuthError } from './fortnox/oauth-error';
import { createLogger } from '@/lib/logger';

const log = createLogger('providers/resolve-consent');

export interface ResolvedConsent {
  consent: Record<string, unknown>;
  accessToken: string;
  providerCompanyId?: string;
  credentialRevision?: string;
}

export async function resolveConsent(companyId: string, consentId: string): Promise<ResolvedConsent> {
  const supabase = createServiceClient();

  // Load consent
  const { data: consentRows } = await queryInExecutionBudget(supabase
    .from('provider_consents')
    .select('*')
    .eq('id', consentId)
    .eq('company_id', companyId)
    .limit(1));

  if (!consentRows || consentRows.length === 0) {
    throw { status: 404, message: 'Consent not found' };
  }

  const consent = consentRows[0]!;
  // Accept status 0 (token submitted, migration pending) and 1 (fully accepted)
  if (consent.status !== 0 && consent.status !== 1) {
    throw { status: 403, message: 'Consent is not in a valid status' };
  }

  if (!consent.provider) {
    throw { status: 400, message: 'Consent has no provider set: complete onboarding first' };
  }

  // Load tokens
  const { data: tokenRows } = await queryInExecutionBudget(supabase
    .from('provider_consent_tokens')
    .select('*')
    .eq('consent_id', consentId)
    .limit(1));

  if (!tokenRows || tokenRows.length === 0) {
    throw { status: 401, message: 'No tokens found for this consent: complete OAuth first' };
  }

  const tokens = tokenRows[0]!;

  // Bokio: private API tokens that don't expire
  if (consent.provider === 'bokio') {
    return {
      consent,
      accessToken: tokens.access_token as string,
      providerCompanyId: tokens.provider_company_id as string | undefined,
    };
  }

  // Björn Lunden: client credentials, auto-refresh when expired
  if (consent.provider === 'bjornlunden') {
    if (tokens.token_expires_at && new Date(tokens.token_expires_at as string) < new Date()) {
      const refreshed = await refreshWithinBudget(() => refreshBjornLundenToken());
      const newExpiresAt = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();

      await queryInExecutionBudget(supabase
        .from('provider_consent_tokens')
        .update({
          access_token: refreshed.access_token,
          token_expires_at: newExpiresAt,
        })
        .eq('consent_id', consentId));

      return {
        consent,
        accessToken: refreshed.access_token,
        providerCompanyId: tokens.provider_company_id as string | undefined,
      };
    }

    return {
      consent,
      accessToken: tokens.access_token as string,
      providerCompanyId: tokens.provider_company_id as string | undefined,
    };
  }

  // Check expiry, auto-refresh if needed
  if (tokens.token_expires_at && new Date(tokens.token_expires_at as string) < new Date()) {
    if (!tokens.refresh_token) {
      if (consent.provider === 'fortnox') throw new ProviderCallError('PROVIDER_AUTH_EXPIRED', 'fortnox',
        'Fortnox access token expired without a refresh token', { providerCode: 'refresh_token_missing', credentialRevision: tokens.credential_revision as string });
      throw { status: 401, message: 'Access token expired and no refresh token available' };
    }

    let refreshed: TokenResponse;

    // Fortnox preserves the provider's failure evidence. Other providers keep
    // their legacy refresh classification until their transports are updated.
    try {
      if (consent.provider === 'fortnox') {
        refreshed = await refreshWithinBudget(() => refreshFortnoxToken(getOAuthConfig('fortnox'), tokens.refresh_token as string));
      } else if (consent.provider === 'briox') {
        // Briox /tokenrefresh wants the (expired) access token alongside the
        // refresh token; no app-level config involved. Both tokens rotate:
        // the new refresh_token is persisted below.
        refreshed = await refreshWithinBudget(() => refreshBrioxToken(tokens.refresh_token as string, tokens.access_token as string));
      } else if (consent.provider === 'wint') {
        // WINT rotates the pair on refresh (the response is a full login
        // envelope); the guarded update below persists the new refresh_token.
        refreshed = await refreshWithinBudget(() => refreshWintToken(tokens.refresh_token as string));
      } else {
        refreshed = await refreshWithinBudget(() => refreshVismaToken(getOAuthConfig(consent.provider as string), tokens.refresh_token as string));
      }
    } catch (err) {
      if (err instanceof ExecutionBudgetExceeded || isTimeoutError(err)) throw err;
      checkExecutionBudget();
      if (consent.provider === 'fortnox') {
        const code = classifyProviderError(err) ?? 'PROVIDER_UPSTREAM_ERROR';
        // A competing refresh/reconnect may have made this request obsolete.
        // The completion block RPC also checks this atomically when recording.
        if (code === 'PROVIDER_AUTH_EXPIRED') {
          const { data: freshRows, error: readError } = await queryInExecutionBudget(supabase
            .from('provider_consent_tokens').select('*').eq('consent_id', consentId).limit(1));
          if (readError) throw new Error('Could not reconcile Fortnox credentials');
          const fresh = freshRows?.[0];
          if (fresh?.access_token && fresh.credential_revision !== tokens.credential_revision) {
            return { consent, accessToken: fresh.access_token as string,
              providerCompanyId: fresh.provider_company_id as string | undefined,
              credentialRevision: fresh.credential_revision as string };
          }
        }
        throw new ProviderCallError(code, 'fortnox', `Fortnox credential resolution failed (${code})`, {
          status: err instanceof FortnoxOAuthError ? err.status : undefined,
          providerCode: err instanceof FortnoxOAuthError ? err.providerCode : undefined,
          retryAfterSeconds: err instanceof FortnoxOAuthError ? err.retryAfterSeconds : undefined,
          credentialRevision: tokens.credential_revision as string,
        });
      }
      const reason = err instanceof Error ? err.message : String(err);
      // A missing/inactive integration license (Fortnox `error_missing_license`)
      // is NOT a revivable token: re-authorizing loops until the customer
      // re-orders the license. Surface it as its own code so the caller shows
      // "activate the license, then reconnect" instead of a bare reconnect.
      const code = isMissingLicenseError(reason)
        ? 'PROVIDER_LICENSE_MISSING'
        : 'PROVIDER_AUTH_EXPIRED';
      log.error(
        `Failed to refresh ${consent.provider} token for consent ${consentId}: ` +
        (code === 'PROVIDER_LICENSE_MISSING'
          ? 'the integration license is missing/inactive'
          : 'the connection must be re-authorized'),
        { reason },
      );
      throw new ProviderCallError(
        code,
        consent.provider as string,
        code === 'PROVIDER_LICENSE_MISSING'
          ? `${consent.provider} integration license missing/inactive; the customer must re-order it before reconnecting`
          : `Token refresh failed for ${consent.provider}; the connection must be re-authorized`,
      );
    }

    const newExpiresAt = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();

    // Optimistic concurrency guard: providers like Briox and Fortnox rotate
    // BOTH tokens on refresh, so two concurrent requests refreshing the same
    // expired pair must not both persist: the second write would overwrite
    // the pair the first request just stored with a possibly-dead one. Fortnox
    // uses a credential revision; other providers retain token_expires_at. If
    // another request rotated, zero rows match and we adopt the stored pair.
    const refreshUpdate = supabase
      .from('provider_consent_tokens')
      .update({
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token,
        token_expires_at: newExpiresAt,
      })
      .eq('consent_id', consentId);
    const guardedUpdate = consent.provider === 'fortnox'
      ? refreshUpdate.eq('credential_revision', tokens.credential_revision as string)
      : refreshUpdate.eq('token_expires_at', tokens.token_expires_at as string);
    const { data: updatedRows, error: updateError } = await queryInExecutionBudget(guardedUpdate
      // consent_id is the table's PRIMARY KEY: there is no `id` column.
      // Selecting `id` here makes Postgres reject the whole statement
      // ("column provider_consent_tokens.id does not exist"), which surfaces as
      // updateError and is misreported as "rotated tokens could not be saved"
      // AFTER the provider already rotated, permanently breaking the consent.
      .select('consent_id, credential_revision'));

    if (updateError) {
      // The provider has ALREADY rotated the tokens but we failed to persist
      // the new pair: the stored pair is now dead and every later call on
      // this consent will fail. Log loudly; the only recovery is to
      // disconnect and re-enter the provider credentials.
      log.error(
        `Failed to persist rotated ${consent.provider} tokens for consent ${consentId}: ` +
        'the stored credentials are now invalid and the consent will break',
        { reason: updateError.message },
      );
      throw {
        status: 500,
        message:
          'Token refresh succeeded at the provider but the rotated tokens could not be saved. ' +
          'The stored credentials are no longer valid: disconnect the provider and re-enter the credentials.',
      };
    }

    if (!updatedRows || updatedRows.length === 0) {
      // Lost the refresh race: a concurrent request already rotated and
      // persisted a fresh pair. Use those tokens as-is: calling the provider
      // refresh endpoint again here would invalidate the winner's pair.
      const { data: freshRows } = await queryInExecutionBudget(supabase
        .from('provider_consent_tokens')
        .select('*')
        .eq('consent_id', consentId)
        .limit(1));

      const fresh = freshRows?.[0];
      if (fresh?.access_token) {
        return {
          consent,
          accessToken: fresh.access_token as string,
          providerCompanyId: (fresh.provider_company_id ?? tokens.provider_company_id) as
            | string
            | undefined,
          credentialRevision: fresh.credential_revision as string | undefined,
        };
      }
      // Token row vanished mid-flight (disconnect?): fall through to our own
      // refreshed pair, which the provider still considers the latest one.
    }

    return {
      consent,
      accessToken: refreshed.access_token,
      providerCompanyId: tokens.provider_company_id as string | undefined,
      credentialRevision: updatedRows?.[0]?.credential_revision as string | undefined,
    };
  }

  return {
    consent,
    accessToken: tokens.access_token as string,
    providerCompanyId: tokens.provider_company_id as string | undefined,
    credentialRevision: tokens.credential_revision as string | undefined,
  };
}

/** Never rotate a token unless there is time left to save the returned pair. */
async function refreshWithinBudget(refresh: () => Promise<TokenResponse>): Promise<TokenResponse> {
  const budget = currentExecutionBudget();
  if (!budget) return refresh();
  const persistenceReserve = 5_000;
  if (budget.deadline - Date.now() < OAUTH_TIMEOUT_MS + persistenceReserve) {
    throw new ExecutionBudgetExceeded('credential-refresh');
  }
  return withExecutionDeadline(budget.deadline - persistenceReserve, 'credential-refresh', refresh);
}
