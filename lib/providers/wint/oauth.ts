import { WINT_BASE_URL } from './config';
import { WintApiError } from './client';
import type { TokenResponse } from '../types';
import {
  fetchWithTimeout,
  OAUTH_TIMEOUT_MS,
} from '@/lib/http/fetch-with-timeout';

// WINT has no OAuth and no API keys (per their own swagger): authentication is
// the user's WINT login exchanged ONCE, server-side, for an
// AccessToken/RefreshToken pair. The password is used in loginWint and nowhere
// else: it must never be persisted or logged. Only the token pair is stored.

/** Mirror of WINT's LoginState enum (POST /api/Auth/jwt response). */
export type WintLoginState =
  | 'Success'
  | 'WrongUsernameOrPassword'
  | 'AccountLocked'
  | 'NoCompanies'
  | 'Timeout'
  | 'UnknownBankIdError'
  | 'IncorrectPersonalNumber'
  | 'ForceLoginWithBankId';

export class WintLoginRejectedError extends Error {
  constructor(public readonly state: WintLoginState | string) {
    super(`WINT rejected the login: ${state}`);
    this.name = 'WintLoginRejectedError';
  }
}

interface WintAuthResponse {
  State?: WintLoginState | number | string;
  AuthTokens?: {
    AccessToken?: string | null;
    RefreshToken?: string | null;
  } | null;
  CompanyNames?: unknown[];
}

// The response serializes State as a string in the swagger examples but the
// enum doc also lists ordinals ("0 - Success, 1 - WrongUsernameOrPassword,
// ..."): accept both shapes.
const LOGIN_STATES: WintLoginState[] = [
  'Success',
  'WrongUsernameOrPassword',
  'AccountLocked',
  'NoCompanies',
  'Timeout',
  'UnknownBankIdError',
  'IncorrectPersonalNumber',
  'ForceLoginWithBankId',
];

function normalizeLoginState(state: WintAuthResponse['State']): WintLoginState | string {
  if (typeof state === 'number') return LOGIN_STATES[state] ?? `Unknown(${state})`;
  if (typeof state === 'string' && state !== '') {
    const asIndex = Number(state);
    if (Number.isInteger(asIndex) && LOGIN_STATES[asIndex]) return LOGIN_STATES[asIndex];
    return state;
  }
  return 'Unknown';
}

/**
 * WINT does not document token lifetimes. The access token is a JWT, so read
 * `exp` straight from its payload; fall back to 15 minutes when the token is
 * opaque or unparsable so the refresh path engages early rather than never.
 */
export function jwtExpiresInSeconds(token: string, nowMs: number = Date.now()): number {
  const FALLBACK_SECONDS = 15 * 60;
  const parts = token.split('.');
  if (parts.length !== 3) return FALLBACK_SECONDS;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as {
      exp?: unknown;
    };
    const exp = Number(payload.exp);
    if (!Number.isFinite(exp)) return FALLBACK_SECONDS;
    const seconds = Math.floor(exp - nowMs / 1000);
    return seconds > 0 ? seconds : FALLBACK_SECONDS;
  } catch {
    return FALLBACK_SECONDS;
  }
}

function toTokenResponse(auth: WintAuthResponse, context: string): TokenResponse {
  // Strict on purpose: anything other than an explicit Success is rejected.
  // Accepting an ambiguous response here would mint a consent that LOOKS
  // connected but cannot refresh, which surfaces days later as a broken
  // migration instead of failing loudly at connect time.
  const state = normalizeLoginState(auth.State);
  if (state !== 'Success') {
    throw new WintLoginRejectedError(state);
  }

  const accessToken = auth.AuthTokens?.AccessToken;
  const refreshToken = auth.AuthTokens?.RefreshToken;
  if (!accessToken || !refreshToken) {
    // Refresh is WINT's only token-revival path (no stored password, no API
    // keys): a pair without a refresh token is as unusable as no pair.
    throw new WintApiError(`${context}: response carried an incomplete token pair`, 502);
  }

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: 'Bearer',
    expires_in: jwtExpiresInSeconds(accessToken),
  };
}

async function postAuth(path: string, body: unknown, context: string): Promise<TokenResponse> {
  const response = await fetchWithTimeout(
    `${WINT_BASE_URL}${path}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    },
    { timeoutMs: OAUTH_TIMEOUT_MS, description: context },
  );

  if (!response.ok) {
    const responseBody = await response.text().catch(() => '');
    // 400/401 from the auth endpoints is a credential verdict; carry the
    // status so submitProviderToken can tell it apart from an outage.
    throw new WintApiError(`${context} failed: ${response.status}`, response.status, responseBody);
  }

  const result = (await response.json()) as WintAuthResponse;
  return toTokenResponse(result, context);
}

/**
 * Exchange the user's WINT login for a token pair. The mail/password pair is
 * intentionally NOT retained in any form after this call resolves.
 */
export async function loginWint(mail: string, password: string): Promise<TokenResponse> {
  return postAuth('/api/Auth/jwt', { Mail: mail, Password: password }, 'WINT login');
}

/**
 * Refresh via POST /api/Auth/refresh. The swagger types the request body as a
 * bare JSON string (the refresh token). The response is the same auth envelope
 * as login; treat both tokens as rotated and persist the returned pair.
 */
export async function refreshWintToken(refreshToken: string): Promise<TokenResponse> {
  return postAuth('/api/Auth/refresh', refreshToken, 'WINT token refresh');
}
