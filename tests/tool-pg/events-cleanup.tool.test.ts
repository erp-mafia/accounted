/**
 * The events cleanup cron (GET /api/events/cleanup/cron) through a real
 * supabase-js client and a real PostgREST: the telemetry purge's filters (a
 * range and a LIKE on event_type, a cutoff on created_at) reach Postgres as
 * written. Agent telemetry (mcp.*, agent.*) past 180 days is deleted; every
 * other event_log row and the event outbox are kept, however old.
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import { seedCompany } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'

vi.mock('@/lib/auth/cron', () => ({ verifyCronSecret: () => null }))
vi.mock('@/lib/supabase/server', async () => {
  const { createToolPgClient } = await import('./client')
  return { createServiceClient: () => createToolPgClient() }
})

import { GET } from '@/app/api/events/cleanup/cron/route'
import { createCronRequest } from '@/tests/helpers'

const seeded: string[] = []

afterAll(async () => {
  for (const companyId of seeded) {
    await getPool().query(`DELETE FROM public.event_log WHERE company_id = $1`, [companyId])
    await getPool().query(`DELETE FROM public.event_outbox WHERE company_id = $1`, [companyId])
  }
})

describe('events cleanup cron over PostgREST', () => {
  it('deletes agent telemetry past 180 days and keeps business events and the outbox', async () => {
    const { userId, companyId } = await seedCompany()
    seeded.push(companyId)

    // [event_type, days old, kept]
    const rows: Array<[string, number, boolean]> = [
      ['mcp.tool_called', 200, false],
      ['mcp.skill_loaded', 400, false],
      ['agent.feedback', 181, false],
      ['mcp.tool_called', 179, true],
      ['agent.feedback', 10, true],
      ['invoice.created', 400, true],
      ['transaction.synced', 200, true],
      ['journal_entry.committed', 31, true],
      ['invoice.paid', 1, true],
      // Inside the index ranges [mcp, mcq) and [agent, agenu), outside the
      // prefixes: the LIKE keeps them.
      ['mcp_settings.changed', 200, true],
      ['agentic.step', 200, true],
    ]
    await getPool().query(
      `INSERT INTO public.event_log (user_id, company_id, event_type, data, created_at)
       SELECT $1, $2, r.event_type, jsonb_build_object('n', r.n), now() - make_interval(days => r.days)
         FROM unnest($3::text[], $4::int[]) WITH ORDINALITY AS r(event_type, days, n)`,
      [userId, companyId, rows.map(([type]) => type), rows.map(([, days]) => days)],
    )

    // A finished event of 30 days and a dead one of 60: the outbox prune this
    // cron called until 2026-11-23 deleted both.
    await getPool().query(
      `WITH o AS (
         INSERT INTO public.event_outbox (company_id, event_type, payload, created_at)
         VALUES ($1, 'invoice.created', '{"n": 1}', now() - interval '30 days'),
                ($1, 'invoice.paid', '{"n": 2}', now() - interval '60 days')
         RETURNING id, event_type
       )
       INSERT INTO public.event_deliveries (outbox_id, consumer_id, status, attempts, done_at, created_at)
       SELECT o.id, 'webhooks',
              CASE WHEN o.event_type = 'invoice.created' THEN 'done' ELSE 'dead' END, 1,
              CASE WHEN o.event_type = 'invoice.created' THEN now() - interval '30 days' END,
              now() - interval '30 days'
         FROM o`,
      [companyId],
    )

    const response = await GET(createCronRequest('/api/events/cleanup/cron'))
    expect(response.status).toBe(200)
    const body = (await response.json()) as { success: boolean; deletedTelemetry: number }
    expect(body.success).toBe(true)
    expect(body.deletedTelemetry).toBeGreaterThanOrEqual(3)

    const { rows: left } = await getPool().query<{ event_type: string; days: number }>(
      `SELECT event_type, round(extract(epoch FROM now() - created_at) / 86400)::int AS days
         FROM public.event_log WHERE company_id = $1 ORDER BY event_type, days`,
      [companyId],
    )
    const kept = rows
      .filter(([, , keep]) => keep)
      .map(([event_type, days]) => ({ event_type, days }))
      .sort((a, b) => a.event_type.localeCompare(b.event_type, 'en') || a.days - b.days)
    expect(left.sort((a, b) => a.event_type.localeCompare(b.event_type, 'en') || a.days - b.days)).toEqual(kept)

    const { rows: outbox } = await getPool().query(
      `SELECT o.event_type, d.status
         FROM public.event_outbox o JOIN public.event_deliveries d ON d.outbox_id = o.id
        WHERE o.company_id = $1 ORDER BY o.event_type`,
      [companyId],
    )
    expect(outbox).toEqual([
      { event_type: 'invoice.created', status: 'done' },
      { event_type: 'invoice.paid', status: 'dead' },
    ])
  })
})
