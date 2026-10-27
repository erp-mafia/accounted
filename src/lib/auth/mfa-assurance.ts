import { base64UrlToBytes, bytesToBase64Url, importVerdictKey, type Environment } from './proxy-verdict-key'

/**
 * The proxy's MFA verdict for one API request, handed to the route it
 * forwards the request to.
 *
 * requireAuth refuses a session below AAL2 of a user who has a verified
 * factor, and it had to ask the auth server (listFactors(), a GoTrue round
 * trip) on every API request of an AAL1 session to learn there is none. The
 * proxy has just read the same factor list off its server-authenticated
 * getUser() call for that request, so it signs "this user has no verified
 * factor" for the session it checked and requireAuth takes that instead of
 * asking again.
 *
 * The verdict is bound to the user and the session and lives for 30
 * seconds: it is meant for the request the proxy forwards, nothing else. The
 * proxy deletes a client-sent header on every request it handles, and one
 * that reaches a route without passing the proxy fails the signature, which
 * needs the server-only secret. Anything that does not verify falls back to
 * listFactors().
 */
export const MFA_ASSURANCE_HEADER = 'x-accounted-mfa-assurance'

const SIGNING_CONTEXT = 'accounted-mfa-assurance-v1:'
const TTL_MS = 30_000
/** The proxy and the route can run on machines whose clocks differ a little. */
const CLOCK_SKEW_MS = 5_000

async function importKey(env: Environment): Promise<CryptoKey> {
  return importVerdictKey(SIGNING_CONTEXT, env)
}

function message(userId: string, sessionId: string, expiresAt: number): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`${SIGNING_CONTEXT}${userId}|${sessionId}|${expiresAt}`)
}

/**
 * The signed verdict that `userId`'s session `sessionId` belongs to a user
 * without a verified factor, or null when it cannot be signed (no secret).
 * Only for a user read off getUser() on this request.
 */
export async function signNoVerifiedFactor(
  args: { userId: string; sessionId: string; now?: number },
  env: Environment = process.env,
): Promise<string | null> {
  try {
    const expiresAt = (args.now ?? Date.now()) + TTL_MS
    const signature = await crypto.subtle.sign('HMAC', await importKey(env), message(args.userId, args.sessionId, expiresAt))
    return `${expiresAt}.${bytesToBase64Url(new Uint8Array(signature))}`
  } catch {
    return null
  }
}

/**
 * Whether `value` is the proxy's verdict for exactly this user and session,
 * unexpired. Fails closed: anything else is false.
 */
export async function verifyNoVerifiedFactor(
  value: string | null | undefined,
  expected: { userId: string; sessionId: string; now?: number },
  env: Environment = process.env,
): Promise<boolean> {
  if (!value) return false
  const [expiresRaw, signatureRaw, extra] = value.split('.')
  if (!expiresRaw || !signatureRaw || extra !== undefined || !/^\d{13}$/.test(expiresRaw)) return false
  const expiresAt = Number(expiresRaw)
  const now = expected.now ?? Date.now()
  // Expired, or minted further ahead than the proxy ever mints.
  if (expiresAt <= now || expiresAt > now + TTL_MS + CLOCK_SKEW_MS) return false
  const signature = base64UrlToBytes(signatureRaw)
  if (!signature) return false
  try {
    return await crypto.subtle.verify('HMAC', await importKey(env), signature, message(expected.userId, expected.sessionId, expiresAt))
  } catch {
    return false
  }
}
