/**
 * Björn Lundén activation via Lundify's redirect flow.
 *
 * BL documents three ways a customer can activate an integration (Company
 * Activation & Key Retrieval, developer.bjornlunden.se/2025/03/31/activation-guide/).
 * The third one removes the GUID copy-paste from our connect step: we send the
 * user to Lundify with our integration activation key, they log in, pick the
 * company and accept the scopes, and Lundify sends them back to our callback
 * with the company's User-Key as `publicKey` and our opaque state as `extra`.
 *
 *   https://lundify.com/activate-integration/{integrationActivationKey}/{encodedRedirectUrl}?extra={state}
 *   -> {redirectUrl}?publicKey={userKey}&extra={state}
 *
 * The activation key is issued by BL once per service provider (ours arrived
 * 2026-09-07). It is not a secret in the credential sense: it is embedded in a
 * URL the customer's browser visits. It still lives in an env var so
 * self-hosted installs without a BL listing simply keep the manual User-Key
 * field.
 */

export const LUNDIFY_ACTIVATION_BASE_URL = 'https://lundify.com/activate-integration';

/**
 * The activation key BL issued for this service provider, or null when the
 * redirect flow is not configured (the connect step then only offers the
 * manual User-Key field).
 */
export function getBjornLundenActivationKey(): string | null {
  const key = process.env.BJORN_LUNDEN_ACTIVATION_KEY?.trim();
  return key ? key : null;
}

/**
 * Build the Lundify activation URL for one connect attempt.
 *
 * `redirectUrl` is our callback (the same one the OAuth providers use) and is
 * percent-encoded as a single path segment, which is what BL's
 * `{encodedRedirectUrl}` placeholder asks for: an unencoded URL would split on
 * its own slashes. `state` is the opaque one-time code minted for the consent;
 * Lundify echoes it back untouched as `extra`, so the callback can resolve the
 * consent from a server-written row instead of trusting anything in the query.
 */
export function buildLundifyActivationUrl(
  activationKey: string,
  redirectUrl: string,
  state: string,
): string {
  const url = new URL(
    `${LUNDIFY_ACTIVATION_BASE_URL}/${encodeURIComponent(activationKey)}/${encodeURIComponent(redirectUrl)}`,
  );
  url.searchParams.set('extra', state);
  return url.toString();
}
