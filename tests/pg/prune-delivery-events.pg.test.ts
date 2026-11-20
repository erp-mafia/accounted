import { randomUUID } from 'crypto'
import { describe, expect, it } from 'vitest'
import { getPool, runAsServiceRole, withUserContext } from './setup'
import { seedCompany } from './fixtures'

/**
 * prune_delivery_events deletes event_log delivery events (every type but
 * mcp.* and agent.*) older than p_before, in batches of p_limit, and never
 * touches telemetry, which the cleanup cron keeps for 180 days.
 */

async function insertEvent(owner: { userId: string; companyId: string }, eventType: string, createdAt: string): Promise<number> {
  const { rows } = await getPool().query<{ sequence: string }>(
    `INSERT INTO public.event_log (user_id, company_id, event_type, data, created_at) VALUES ($1, $2, $3, '{}', $4) RETURNING sequence`,
    [owner.userId, owner.companyId, eventType, createdAt],
  )
  return Number(rows[0].sequence)
}

async function prune(before: string, limit?: number): Promise<number> {
  return runAsServiceRole(async (client) => {
    const { rows } = await client.query<{ n: number }>(
      limit === undefined
        ? `SELECT public.prune_delivery_events($1::timestamptz) AS n`
        : `SELECT public.prune_delivery_events($1::timestamptz, $2) AS n`,
      limit === undefined ? [before] : [before, limit],
    )
    return rows[0].n
  })
}

async function present(sequences: number[]): Promise<number[]> {
  const { rows } = await getPool().query<{ sequence: string }>(
    `SELECT sequence FROM public.event_log WHERE sequence = ANY ($1::bigint[]) ORDER BY sequence`,
    [sequences],
  )
  return rows.map((r) => Number(r.sequence))
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString()

describe('prune_delivery_events', () => {
  it('deletes old delivery events and leaves telemetry and recent events alone', async () => {
    const owner = await seedCompany()
    const type = `test.delivered_${randomUUID().slice(0, 8)}`
    const oldDelivery = await insertEvent(owner, type, daysAgo(40))
    const recentDelivery = await insertEvent(owner, type, daysAgo(5))
    const oldTool = await insertEvent(owner, 'mcp.tool_called', daysAgo(40))
    const oldFeedback = await insertEvent(owner, 'agent.feedback', daysAgo(40))

    expect(await prune(daysAgo(30))).toBeGreaterThanOrEqual(1)

    expect(await present([oldDelivery, recentDelivery, oldTool, oldFeedback])).toEqual([recentDelivery, oldTool, oldFeedback])
  })

  it('deletes at most p_limit rows per call', async () => {
    const owner = await seedCompany()
    const type = `test.batched_${randomUUID().slice(0, 8)}`
    // Other files may leave old delivery events behind: drain them first.
    while ((await prune(daysAgo(30), 1000)) === 1000) { /* drain */ }
    const rows = [await insertEvent(owner, type, daysAgo(50)), await insertEvent(owner, type, daysAgo(50))]

    expect(await prune(daysAgo(30), 1)).toBe(1)
    expect(await present(rows)).toHaveLength(1)
    expect(await prune(daysAgo(30), 1)).toBe(1)
    expect(await present(rows)).toHaveLength(0)
    expect(await prune(daysAgo(30), 1)).toBe(0)
  })

  it('refuses a cutoff less than a day old and an out-of-range limit', async () => {
    await expect(prune(new Date().toISOString())).rejects.toThrow(/at least a day in the past/)
    await expect(prune(daysAgo(30), 0)).rejects.toThrow(/p_limit/)
    await expect(prune(daysAgo(30), 100_001)).rejects.toThrow(/p_limit/)
  })

  it('lets only the service role run it', async () => {
    const { userId } = await seedCompany()
    await expect(withUserContext(userId, (c) => c.query(`SELECT public.prune_delivery_events(now() - interval '30 days')`))).rejects.toThrow(/permission denied/)
  })
})
