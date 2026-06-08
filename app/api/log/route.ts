import { NextResponse } from 'next/server'
import { createLogger } from '@/lib/logger'
import { checkRateLimit } from '@/lib/auth/rate-limit-http'
import { truncateIp } from '@/lib/api/v1/with-api-v1'

const log = createLogger('onboarding-client')

// This is an UNAUTHENTICATED client telemetry sink — it's called from the
// browser during onboarding, before a session necessarily exists, so it can't
// require auth. Abuse is bounded instead by a per-/24 rate limit (log-flooding,
// SOC2 CC6.1) and size caps on the client-supplied fields (OWASP V2.2). PII in
// message/extra is redacted by the structured logger before it reaches Vercel.
const RATE_LIMIT = { maxRequests: 30, windowMs: 60_000 }
const MAX_MESSAGE_LEN = 2000
const MAX_EXTRA_BYTES = 8000

export async function POST(request: Request) {
  try {
    const fwd = request.headers.get('x-forwarded-for')
    const rawIp = fwd ? fwd.split(',')[0]?.trim() : request.headers.get('x-real-ip') ?? undefined
    const identifier = truncateIp(rawIp || undefined) ?? 'unknown'
    const rl = await checkRateLimit({ prefix: 'client-log', identifier, ...RATE_LIMIT })
    if (!rl.ok) return rl.response!

    const body = await request.json()

    // Bound the client-supplied fields before logging: cap the message length
    // and the serialized size of `extra` so a single request can't flood the
    // log pipeline. Shape is coerced rather than strictly schema-rejected —
    // dropping a malformed error report would lose the telemetry this endpoint
    // exists to capture.
    const message =
      typeof body?.message === 'string' ? body.message.slice(0, MAX_MESSAGE_LEN) : 'client onboarding error'
    let extra = body?.extra
    if (extra !== undefined) {
      try {
        if (JSON.stringify(extra).length > MAX_EXTRA_BYTES) extra = { truncated: true }
      } catch {
        extra = undefined // non-serializable (e.g. cyclic) — drop it
      }
    }

    // Route through the structured logger so message + extra are PII-redacted
    // (personnummer / IBAN / tokens via REDACT_KEYS) before reaching Vercel logs.
    log.error('client onboarding error', { clientMessage: message, extra })

    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 })
  }
}
