/**
 * GET /api/events with a types filter through a real supabase-js client and a
 * real PostgREST (crm#2142). Each named type is read on its own, sequences
 * first, and the pages are merged; paging through the feed must still serve
 * every event of the named types exactly once and in sequence order, which is
 * what one query over the same rows answers.
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import { seedCompany } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'

const session = vi.hoisted(() => ({ userId: '', companyId: '' }))

// The session path, on the service role: the route still filters by the
// company itself.
vi.mock('@/lib/auth/require-auth', async () => {
  const { createToolPgClient } = await import('./client')
  return {
    requireAuth: async () => ({ user: { id: session.userId }, supabase: createToolPgClient(), error: null }),
  }
})
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: async () => session.companyId,
}))

import { GET } from '@/app/api/events/route'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'

interface FeedPage {
  data: { sequence: number; event_type: string }[]
  cursor: number
  has_more: boolean
}

async function readFeed(types: string, limit: number): Promise<number[]> {
  const served: number[] = []
  let after = 0
  for (let page = 0; page < 100; page++) {
    const response = await GET(
      createMockRequest('/api/events', { searchParams: { types, limit: String(limit), after: String(after) } }),
    )
    const { status, body } = await parseJsonResponse<FeedPage>(response)
    expect(status).toBe(200)
    served.push(...body.data.map((event) => event.sequence))
    after = body.cursor
    if (!body.has_more) break
  }
  return served
}

afterAll(async () => {
  if (session.companyId) {
    await getPool().query(`DELETE FROM public.event_log WHERE company_id = $1`, [session.companyId])
  }
})

describe('GET /api/events types filter over PostgREST', () => {
  it('pages every event of the named types once, in sequence order', async () => {
    const { userId, companyId } = await seedCompany()
    session.userId = userId
    session.companyId = companyId
    // Interleaved: the named types between telemetry the filter leaves out.
    await getPool().query(
      `INSERT INTO public.event_log (user_id, company_id, event_type, data)
       SELECT $1, $2,
              (ARRAY['invoice.created', 'mcp.tool_called', 'invoice.paid', 'mcp.tool_called', 'customer.created',
                     'mcp.tool_called', 'invoice.created'])[1 + g % 7],
              jsonb_build_object('n', g)
         FROM generate_series(1, 120) g`,
      [userId, companyId],
    )
    const { rows } = await getPool().query<{ sequence: string }>(
      `SELECT sequence FROM public.event_log
        WHERE company_id = $1 AND event_type IN ('invoice.created', 'invoice.paid', 'customer.created')
        ORDER BY sequence`,
      [companyId],
    )
    const expected = rows.map((row) => Number(row.sequence))
    expect(expected.length).toBeGreaterThan(50)

    expect(await readFeed('invoice.created,invoice.paid,customer.created', 7)).toEqual(expected)
    expect(await readFeed('invoice.paid', 4)).toEqual(
      (
        await getPool().query<{ sequence: string }>(
          `SELECT sequence FROM public.event_log WHERE company_id = $1 AND event_type = 'invoice.paid' ORDER BY sequence`,
          [companyId],
        )
      ).rows.map((row) => Number(row.sequence)),
    )
  })
})
