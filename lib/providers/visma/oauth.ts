import { VISMA_AUTH_URL, VISMA_TOKEN_URL, VISMA_REVOKE_URL } from './config';
import type { OAuthConfig, TokenResponse } from '../types';
import {
  fetchWithTimeout,
  OAUTH_TIMEOUT_MS,
  OAUTH_REVOKE_TIMEOUT_MS,
} from '@/lib/http/fetch-with-timeout';

const DEFAULT_SCOPES = [
  'ea:api',
  'offline_access',
  'ea:sales',
  'ea:accounting',
  'ea:purchase',
];

const EACCOUNTING_ACR_VALUE = 'service:44643EB1-3F76-4C1C-A672-402AE8085934';

const ALLOWED_PROMPT_VALUES = new Set(['none', 'login', 'consent', 'select_account']);

export function buildVismaAuthUrl(
  config: OAuthConfig,
  options?: { scopes?: string[]; state?: string; acrValues?: string; prompt?: string },
): string {
  const promptCandidate = options?.prompt ?? 'select_account';
  const prompt = ALLOWED_PROMPT_VALUES.has(promptCandidate) ? promptCandidate : 'select_account';

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    prompt,
    acr_values: options?.acrValues ?? EACCOUNTING_ACR_VALUE,
  });

  const scopes = options?.scopes?.length ? options.scopes : DEFAULT_SCOPES;
  params.set('scope', scopes.join(' '));

  if (options?.state) {
    params.set('state', options.state);
  }

  return `${VISMA_AUTH_URL}?${params.toString()}`;
}

function basicAuthHeader(config: OAuthConfig): string {
  const encoded = btoa(`${config.clientId}:${config.clientSecret}`);
  return `Basic ${encoded}`;
}

export async function exchangeVismaCode(
  config: OAuthConfig,
  code: string,
): Promise<TokenResponse> {
  const response = await fetchWithTimeout(
    VISMA_TOKEN_URL,
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
    { timeoutMs: OAUTH_TIMEOUT_MS, description: 'Visma token exchange' },
  );

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Visma token exchange failed: ${response.status} ${body}`);
  }

  return response.json() as Promise<TokenResponse>;
}

export async function refreshVismaToken(
  config: OAuthConfig,
  refreshToken: string,
): Promise<TokenResponse> {
  const response = await fetchWithTimeout(
    VISMA_TOKEN_URL,
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
    { timeoutMs: OAUTH_TIMEOUT_MS, description: 'Visma token refresh' },
  );

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Visma token refresh failed: ${response.status} ${body}`);
  }

  return response.json() as Promise<TokenResponse>;
}

export async function revokeVismaToken(
  config: OAuthConfig,
  refreshToken: string,
): Promise<boolean> {
  const response = await fetchWithTimeout(
    VISMA_REVOKE_URL,
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
    { timeoutMs: OAUTH_REVOKE_TIMEOUT_MS, description: 'Visma token revoke' },
  );

  return response.ok;
}
