import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { createLogger } from '@/lib/logger'

const log = createLogger('health')

const CACHE_TTL_MS = 5_000

type HealthBody = {
  status: 'healthy' | 'unhealthy'
  timestamp: string
  version: string
}

type CheckResult = {
  body: HealthBody
  status: number
}

type CachedResult = CheckResult & { expires: number }

// In-memory cache shared across requests in the same process. Docker's
// healthcheck polls every 30 s, so the cache always returns fresh data to it,
// but a public flood (multiple requests/second) is served from RAM and never
// reaches Postgres. The cache is intentionally tiny (one entry) because the
// endpoint takes no parameters.
let cached: CachedResult | null = null

// Holds the pending check when one is in flight so concurrent cache misses
// share a single Postgres round-trip. Cleared as soon as the promise settles.
// Bounds the worst case to one DB query per CACHE_TTL_MS window regardless of
// burst arrival rate (e.g. a load-balancer replaying queued probes).
let pending: Promise<CheckResult> | null = null

/**
 * GET /api/health
 * Public health check endpoint (no auth required).
 *
 * Error details are logged server-side only: never echoed to the response
 * body, which would expose Postgres error text on a public endpoint. The
 * logger receives only error.code/error.message; raw Supabase error objects
 * may include schema names, table names, or query fragments that should
 * never reach application logs.
 *
 * Results are cached for {@link CACHE_TTL_MS} so flood traffic does not
 * hammer Postgres with a service-role query per request.
 */
export async function GET() {
  const now = Date.now()
  if (cached && cached.expires > now) {
    return NextResponse.json(cached.body, { status: cached.status })
  }

  const inFlight = pending ?? (pending = runAndCache(now))
  try {
    const result = await inFlight
    return NextResponse.json(result.body, { status: result.status })
  } finally {
    if (pending === inFlight) pending = null
  }
}

async function runAndCache(now: number): Promise<CheckResult> {
  const result = await runHealthCheck()
  cached = { ...result, expires: now + CACHE_TTL_MS }
  return result
}

async function runHealthCheck(): Promise<CheckResult> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !supabaseServiceKey) {
    log.error('Missing Supabase configuration for health check')
    return {
      body: { status: 'unhealthy', timestamp: new Date().toISOString(), version: '1.0.0' },
      status: 503,
    }
  }

  try {
    const supabase = createClient(supabaseUrl, supabaseServiceKey)
    const { error } = await supabase
      .from('fiscal_periods')
      .select('id', { count: 'exact', head: true })
      .limit(1)

    if (error) {
      // PostgrestError is a plain object: { code, message, details, hint }.
      // details/hint can contain table or column names; log only the
      // operationally useful fields.
      log.error('Database health check failed', {
        errCode: error.code ?? null,
        errMessage: error.message ?? null,
      })
      return {
        body: { status: 'unhealthy', timestamp: new Date().toISOString(), version: '1.0.0' },
        status: 503,
      }
    }

    return {
      body: { status: 'healthy', timestamp: new Date().toISOString(), version: '1.0.0' },
      status: 200,
    }
  } catch (err) {
    // Caught Error instances are reduced to {name, message, code} by the
    // logger's redactor; never pass the raw value lest a deep stack containing
    // query strings ends up in production logs.
    const e = err as { name?: unknown; message?: unknown; code?: unknown }
    log.error('Health check unexpected error', {
      errName: typeof e?.name === 'string' ? e.name : null,
      errMessage: typeof e?.message === 'string' ? e.message : null,
      errCode: typeof e?.code === 'string' ? e.code : null,
    })
    return {
      body: { status: 'unhealthy', timestamp: new Date().toISOString(), version: '1.0.0' },
      status: 503,
    }
  }
}
