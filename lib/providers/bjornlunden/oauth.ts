import type { TokenResponse } from '../types';
import {
  fetchWithTimeout,
  OAUTH_TIMEOUT_MS,
} from '@/lib/http/fetch-with-timeout';

const BL_AUTH_URL = 'https://apigateway.blinfo.se/auth/oauth/v2/token';

export async function fetchBjornLundenToken(
  clientId: string,
  clientSecret: string,
): Promise<TokenResponse> {
  const response = await fetchWithTimeout(
    BL_AUTH_URL,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
    },
    { timeoutMs: OAUTH_TIMEOUT_MS, description: 'Björn Lundén token request' },
  );

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Björn Lunden token request failed: ${response.status} ${body}`);
  }

  const data = await response.json() as Record<string, unknown>;
  return {
    access_token: data.access_token as string,
    refresh_token: '',
    token_type: (data.token_type as string) ?? 'Bearer',
    expires_in: (data.expires_in as number) ?? 3600,
  };
}

export async function refreshBjornLundenToken(): Promise<TokenResponse> {
  const clientId = process.env.BJORN_LUNDEN_CLIENT_ID ?? '';
  const clientSecret = process.env.BJORN_LUNDEN_CLIENT_SECRET ?? '';
  if (!clientId || !clientSecret) {
    throw new Error('BJORN_LUNDEN_CLIENT_ID and BJORN_LUNDEN_CLIENT_SECRET must be set');
  }
  return fetchBjornLundenToken(clientId, clientSecret);
}

