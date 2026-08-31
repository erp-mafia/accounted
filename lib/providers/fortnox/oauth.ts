import { FORTNOX_AUTH_URL, FORTNOX_TOKEN_URL } from './config';
import type { OAuthConfig, TokenResponse } from '../types';
import {
  fetchWithTimeout,
  OAUTH_TIMEOUT_MS,
  OAUTH_REVOKE_TIMEOUT_MS,
} from '@/lib/http/fetch-with-timeout';

const BASE_SCOPES = [
  'companyinformation',
  'invoice',
  'supplierinvoice',
  'customer',
  'supplier',
  'bookkeeping',
];

/** Arkivplats + Koppla filer: what the voucher attachment import reads. */
export const FORTNOX_DOCUMENT_SCOPES = ['archive', 'connectfile'];

/**
 * Whether the registered Fortnox app has Arkivplats and Koppla filer enabled in
 * the Fortnox Developer Portal (integration 39254). True since 2026-08-21, when
 * the portal registration was confirmed to carry both.
 *
 * Requesting a scope the app lacks makes the authorize endpoint reject with
 * invalid_scope BEFORE login, so set this back to false the moment the portal
 * loses them, rather than leaving the underlag reconnect pointed at a scope
 * Fortnox will refuse (prod incident 2026-08-13, when the ordinary connect
 * still carried these scopes and every Fortnox connection died).
 *
 * It gates the opt-in document consent below and the document-import error
 * message, never the ordinary connect: a user is never told to reconnect for a
 * permission we don't ask for (support case Klura AB, 2026-08-20).
 */
export const FORTNOX_DOCUMENT_SCOPES_APPROVED: boolean = true;

/** The asset register (anläggningsregistret): what the asset import reads. */
export const FORTNOX_ASSET_SCOPES = ['assets'];

/**
 * Whether the registered Fortnox app has the Assets scope (Anläggningsregister)
 * enabled in the Fortnox Developer Portal. Ships false until the portal
 * registration is confirmed to carry it: requesting a scope the app lacks
 * makes the authorize endpoint reject with invalid_scope BEFORE login, the
 * same failure mode the document scopes guard against above.
 *
 * When true, the ordinary connect requests the scope. Unlike Arkivplats and
 * Koppla filer, the asset register carries no separate Fortnox customer
 * licence, so no per-user opt-in is needed. A consent minted without the
 * scope degrades gracefully: the migration reports assets as skipped instead
 * of failing (see arcim-migration import-assets).
 */
export const FORTNOX_ASSET_SCOPES_APPROVED: boolean = false;

/**
 * The scopes a Fortnox consent is minted with. The document scopes are opt-in
 * per authorize call, because Fortnox derives its customer licence
 * requirements from what an integration requests: a customer who never imports
 * receipts should not be asked to hold an Arkivplats licence to connect at all.
 *
 * The base scopes always ride along. The OAuth callback overwrites the
 * consent's tokens in place, so a document consent minted from the two extra
 * scopes alone would strip the migration's own access to the ledger.
 */
export function fortnoxConsentScopes(options?: { documents?: boolean }): string[] {
  const withDocuments =
    options?.documents === true && FORTNOX_DOCUMENT_SCOPES_APPROVED;
  const scopes = withDocuments
    ? [...BASE_SCOPES, ...FORTNOX_DOCUMENT_SCOPES]
    : [...BASE_SCOPES];
  // The asset register rides along on every consent once the portal
  // registration carries the scope: it needs no extra customer licence, so
  // there is nothing to opt in to.
  if (FORTNOX_ASSET_SCOPES_APPROVED) scopes.push(...FORTNOX_ASSET_SCOPES);
  return scopes;
}

export function buildFortnoxAuthUrl(
  config: OAuthConfig,
  options?: { scopes?: string[]; state?: string },
): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    access_type: 'offline',
  });

  const scopes = options?.scopes?.length
    ? options.scopes
    : fortnoxConsentScopes();
  params.set('scope', scopes.join(' '));

  if (options?.state) {
    params.set('state', options.state);
  }

  return `${FORTNOX_AUTH_URL}?${params.toString()}`;
}

function basicAuthHeader(config: OAuthConfig): string {
  const encoded = btoa(`${config.clientId}:${config.clientSecret}`);
  return `Basic ${encoded}`;
}

export async function exchangeFortnoxCode(
  config: OAuthConfig,
  code: string,
): Promise<TokenResponse> {
  const response = await fetchWithTimeout(
    FORTNOX_TOKEN_URL,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: basicAuthHeader(config),
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: config.redirectUri,
      }).toString(),
    },
    { timeoutMs: OAUTH_TIMEOUT_MS, description: 'Fortnox token exchange' },
  );

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Fortnox token exchange failed: ${response.status} ${body}`);
  }

  return response.json() as Promise<TokenResponse>;
}

export async function refreshFortnoxToken(
  config: OAuthConfig,
  refreshToken: string,
): Promise<TokenResponse> {
  const response = await fetchWithTimeout(
    FORTNOX_TOKEN_URL,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: basicAuthHeader(config),
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }).toString(),
    },
    { timeoutMs: OAUTH_TIMEOUT_MS, description: 'Fortnox token refresh' },
  );

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Fortnox token refresh failed: ${response.status} ${body}`);
  }

  return response.json() as Promise<TokenResponse>;
}

export async function revokeFortnoxToken(
  config: OAuthConfig,
  refreshToken: string,
): Promise<boolean> {
  const response = await fetchWithTimeout(
    FORTNOX_TOKEN_URL,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: basicAuthHeader(config),
      },
      body: new URLSearchParams({
        token: refreshToken,
        token_type_hint: 'refresh_token',
      }).toString(),
    },
    { timeoutMs: OAUTH_REVOKE_TIMEOUT_MS, description: 'Fortnox token revoke' },
  );

  return response.ok;
}
