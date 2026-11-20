import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createTokenRateLimiter } from '@/lib/api/token-rate-limit'
import { validateBody } from '@/lib/api/validate'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { createLogger } from '@/lib/logger'
import { endUserIp } from '@/lib/signing/ceremony-routes'
import { verifySignedFile } from '@/lib/signing/verify'

// 30 checks per address per 10 minutes: a person checks a few files, a
// scraper guessing hashes learns nothing anyway (a hash finds only its file).
// Process-local, like the signing link's limiters.
const limiter = createTokenRateLimiter({ max: 30, windowMs: 10 * 60_000 })

const VerifySchema = z.object({ sha256: z.string().trim().toLowerCase().regex(/^[0-9a-f]{64}$/) }).strict()

/**
 * POST /api/verifiera: is the file with this SHA-256 a copy signed through
 * Accounted (lib/signing/verify.ts)? Public, no account: the page hashes the
 * file in the browser and sends only the hash. Answers { found: false } or
 * what the copy's own Signeringsbevis page prints.
 */
export async function POST(request: Request): Promise<Response> {
  const requestId = randomUUID()
  const log = createLogger('verifiera', { requestId, operation: 'signing.verify' })
  try {
    if (!limiter.allow(`ip:${endUserIp(request)}`)) return errorResponseFromCode('RATE_LIMITED', log, { requestId, reason: 'verify over its budget' })
    const validation = await validateBody(request, VerifySchema)
    if (!validation.success) return validation.response
    const found = await verifySignedFile(createServiceClientNoCookies(), validation.data.sha256)
    log.info('signed file checked', { found: Boolean(found) })
    return NextResponse.json({ data: found ? { found: true, ...found } : { found: false } }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    return errorResponse(error, log, { requestId })
  }
}
