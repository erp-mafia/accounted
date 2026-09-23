/**
 * GET /api/v1/health: public health check.
 *
 * Returns service status. No auth required. Used by load balancers, uptime
 * checks, and as a smoke test for the v1 wrapper itself.
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { API_V1_VERSION } from '@/lib/api/v1/version'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'

const HealthResponse = z.object({
  status: z.enum(['ok', 'degraded']),
  service: z.literal('gnubok'),
  api_version: z.string(),
  timestamp: z.string(),
})

registerEndpoint({
  operation: 'health.check',
  method: 'GET',
  path: '/api/v1/health',
  summary: 'Health check.',
  description: 'Reports the API is reachable and what version is currently served. Public; no auth required.',
  useWhen: 'You want to verify connectivity, latency, or which API version is live before issuing other requests.',
  doNotUseFor: 'Anything that needs authenticated data. This endpoint returns no company-specific information.',
  pitfalls: [
    'A 200 here only means the API process responds: downstream Postgres/Supabase may still be degraded.',
  ],
  example: {
    response: {
      data: {
        status: 'ok',
        service: 'gnubok',
        api_version: '2026-05-12',
        timestamp: '2026-05-12T16:25:06Z',
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: null,
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: { success: dataEnvelope(HealthResponse) },
})

export const GET = withApiV1('health.check', async (_request, ctx) => {
  return ok(
    {
      status: 'ok' as const,
      service: 'gnubok' as const,
      api_version: API_V1_VERSION,
      timestamp: new Date().toISOString(),
    },
    { requestId: ctx.requestId },
  )
})
