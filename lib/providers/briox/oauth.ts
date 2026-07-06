import { BRIOX_TOKEN_URL, BRIOX_REFRESH_URL } from './config';
import { BrioxApiError } from './client';
import type { TokenResponse } from '../types';
import {
  fetchWithTimeout,
  OAUTH_TIMEOUT_MS,
} from '@/lib/http/fetch-with-timeout';

interface BrioxTokenData {
  access_token: string;
  refresh_token: string;
  // Swagger declares both as strings ("35649125", "1640772931") but be
  // tolerant of numbers: toTokenResponse coerces before arithmetic.
  client_id: string | number;
  expire_date: string;
  expire_timestamp: string | number;
}

interface BrioxTokenApiResponse {
  data: BrioxTokenData;
}

function toTokenResponse(brioxData: BrioxTokenData): TokenResponse {
  const expiresIn = Number(brioxData.expire_timestamp) - Math.floor(Date.now() / 1000);
  return {
    access_token: brioxData.access_token,
    refresh_token: brioxData.refresh_token,
    token_type: 'Bearer',
    expires_in: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600,
  };
}

async function postForToken(url: string, description: string): Promise<TokenResponse> {
  const response = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
    },
    { timeoutMs: OAUTH_TIMEOUT_MS, description },
  );

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    // BrioxApiError carries statusCode so callers can tell wrong credentials
    // (400/401/404 from /token) apart from transient upstream failures.
    throw new BrioxApiError(`${description} failed: ${response.status} ${body}`, response.status, body);
  }

  const result = await response.json() as BrioxTokenApiResponse;
  return toTokenResponse(result.data);
}

/**
 * Exchange the user's account ID + application token for an access/refresh
 * token pair. The "clientid" is the user's Briox account ID (the long number
 * next to the company name under "Your Account"), NOT an app-level credential:
 * Briox has no developer client id/secret on our side.
 */
export async function exchangeBrioxCode(
  accountId: string,
  applicationToken: string,
): Promise<TokenResponse> {
  const url = `${BRIOX_TOKEN_URL}?clientid=${encodeURIComponent(accountId)}&token=${encodeURIComponent(applicationToken)}`;
  return postForToken(url, 'Briox token exchange');
}

/**
 * Refresh an expired access token. Per the swagger, /tokenrefresh takes the
 * refresh token as `refreshtoken` and the CURRENT (expired) access token as
 * `token`. Briox rotates both tokens: the caller must persist the new
 * refresh_token from the response or the next refresh will fail.
 */
export async function refreshBrioxToken(
  refreshToken: string,
  currentAccessToken: string,
): Promise<TokenResponse> {
  const url = `${BRIOX_REFRESH_URL}?refreshtoken=${encodeURIComponent(refreshToken)}&token=${encodeURIComponent(currentAccessToken)}`;
  return postForToken(url, 'Briox token refresh');
}
