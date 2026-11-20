import { base64UrlToBytes, bytesToBase64Url, importVerdictKey, type Environment } from './proxy-verdict-key'

/**
 * The proxy's active-company resolution for one page request, handed to the
 * server render it forwards the request to.
 *
 * The proxy resolves the active company on every signed-in page request
 * (resolve_active_company: the no-company redirects, the books gate and the
 * locale cookie hang off it), and the dashboard render then resolved it a
 * second time for the very same request: generateMetadata, the layout and
 * the page share one request-cached lookup, but not with the proxy. On
 * production that second call was about a third of every
 * resolve_active_company call. So the proxy signs what it resolved, bound to
 * the user, the session and the company, and the render takes that instead
 * of asking again.
 *
 * GET requests only: a Server Action (a POST to a page path) can switch the
 * company before the same request renders, so it always resolves for itself.
 * The verdict lives for 30 seconds: it is meant for the request the proxy
 * forwards, nothing else. The proxy deletes a client-sent header on every
 * request it handles, and one that reaches a render without passing the
 * proxy fails the signature, which needs the server-only secret. Anything
 * that does not verify falls back to resolving the company, so the verdict
 * can only ever save a round trip, never decide one: RLS reads
 * user_preferences itself on every query either way.
 */
export const ACTIVE_COMPANY_HEADER = 'x-accounted-active-company'

const SIGNING_CONTEXT = 'accounted-active-company-v1:'
const TTL_MS = 30_000
/** The proxy and the render can run on machines whose clocks differ a little. */
const CLOCK_SKEW_MS = 5_000
/** A company id is a uuid: never a dot, so it cannot shift the other fields. */
const COMPANY_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function importKey(env: Environment): Promise<CryptoKey> {
  return importVerdictKey(SIGNING_CONTEXT, env)
}

function message(userId: string, sessionId: string, companyId: string, expiresAt: number): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`${SIGNING_CONTEXT}${userId}|${sessionId}|${companyId}|${expiresAt}`)
}

/**
 * The signed verdict that `companyId` is the active company the proxy just
 * resolved for `userId`'s session `sessionId`, or null when it cannot be
 * signed (no secret, or a value that is not a company id).
 */
export async function signActiveCompany(
  args: { userId: string; sessionId: string; companyId: string; now?: number },
  env: Environment = process.env,
): Promise<string | null> {
  if (!COMPANY_ID_RE.test(args.companyId)) return null
  try {
    const expiresAt = (args.now ?? Date.now()) + TTL_MS
    const signature = await crypto.subtle.sign(
      'HMAC',
      await importKey(env),
      message(args.userId, args.sessionId, args.companyId, expiresAt),
    )
    return `${args.companyId}.${expiresAt}.${bytesToBase64Url(new Uint8Array(signature))}`
  } catch {
    // No signing secret (or no WebCrypto): sign nothing, and the render
    // resolves the company itself, exactly as without the verdict.
    return null
  }
}

/**
 * The company id `value` vouches for, when it is the proxy's unexpired
 * verdict for exactly this user and session. Fails closed: anything else is
 * null, and the caller resolves the company itself.
 */
export async function verifyActiveCompany(
  value: string | null | undefined,
  expected: { userId: string; sessionId: string; now?: number },
  env: Environment = process.env,
): Promise<string | null> {
  if (!value) return null
  const [companyId, expiresRaw, signatureRaw, extra] = value.split('.')
  if (!companyId || !expiresRaw || !signatureRaw || extra !== undefined) return null
  if (!COMPANY_ID_RE.test(companyId) || !/^\d{13}$/.test(expiresRaw)) return null
  const expiresAt = Number(expiresRaw)
  const now = expected.now ?? Date.now()
  // Expired, or minted further ahead than the proxy ever mints.
  if (expiresAt <= now || expiresAt > now + TTL_MS + CLOCK_SKEW_MS) return null
  const signature = base64UrlToBytes(signatureRaw)
  if (!signature) return null
  try {
    const valid = await crypto.subtle.verify(
      'HMAC',
      await importKey(env),
      signature,
      message(expected.userId, expected.sessionId, companyId, expiresAt),
    )
    return valid ? companyId : null
  } catch {
    // No secret or an unusable signature: fail closed, the caller resolves.
    return null
  }
}
