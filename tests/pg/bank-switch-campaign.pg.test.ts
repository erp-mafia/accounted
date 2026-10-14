import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { seedCompany } from './fixtures'
import { getClient, getPool } from './setup'

// Migration 20261012170000: the switch campaign's send log and its counter.
// The campaign state itself is computed in TypeScript (lib/bank-feed/
// switch-campaign.ts); the RPC mirrors that classification in SQL for the
// totals, so this suite pins both halves of the mirror: which rows count as
// pending, uncovered and switched, and who may read any of it.

let a: Awaited<ReturnType<typeof seedCompany>>
let b: Awaited<ReturnType<typeof seedCompany>>
let client: PoolClient

beforeEach(async () => {
  a = await seedCompany()
  b = await seedCompany()
  client = await getClient()
  await client.query('BEGIN')
})
afterEach(async () => {
  await client.query('ROLLBACK')
  client.release()
})

async function connection(input: {
  company: { companyId: string; userId: string }
  aggregator: 'enable_banking' | 'open_payments'
  bank: string | null
  status?: string
  supersededBy?: string | null
}): Promise<string> {
  const id = randomUUID()
  await client.query(
    `INSERT INTO bank_connections(id, company_id, user_id, provider, bank_name, status, aggregator, bic, session_id, superseded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      id,
      input.company.companyId,
      input.company.userId,
      input.aggregator === 'open_payments' ? 'open_payments' : `${(input.bank ?? 'bank').toLowerCase().replace(/\s+/g, '-')}-se`,
      input.bank,
      input.status ?? 'active',
      input.aggregator,
      input.aggregator === 'open_payments' ? 'SWEDSESS' : null,
      randomUUID(),
      input.supersededBy ?? null,
    ],
  )
  return id
}

async function asRole(role: 'service_role' | 'authenticated', userId: string) {
  const sub = role === 'service_role' ? '' : userId
  await client.query(
    "SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true),set_config('request.jwt.claim.role',$3,true)",
    [sub, JSON.stringify({ role, ...(sub ? { sub } : {}) }), role],
  )
  await client.query(`SET LOCAL ROLE ${role}`)
}

async function progress(uncovered: string[] = ['wise', 'paypal', 'norwegian', 'first card', 'juni']) {
  return (await client.query('SELECT bank_switch_progress($1) AS result', [uncovered])).rows[0].result
}

describe('bank_switch_notifications', () => {
  it('is RLS-enabled, reachable by the service role alone, and append-only in shape', async () => {
    const rls = await getPool().query<{ relrowsecurity: boolean }>(
      `SELECT relrowsecurity FROM pg_class WHERE oid = 'public.bank_switch_notifications'::regclass`,
    )
    expect(rls.rows[0].relrowsecurity).toBe(true)
    const privileges = await getPool().query<{ auth_select: boolean; auth_insert: boolean; anon_select: boolean; service_insert: boolean }>(`
      SELECT has_table_privilege('authenticated', 'public.bank_switch_notifications', 'SELECT') AS auth_select,
             has_table_privilege('authenticated', 'public.bank_switch_notifications', 'INSERT') AS auth_insert,
             has_table_privilege('anon', 'public.bank_switch_notifications', 'SELECT') AS anon_select,
             has_table_privilege('service_role', 'public.bank_switch_notifications', 'INSERT') AS service_insert`)
    expect(privileges.rows[0]).toEqual({ auth_select: false, auth_insert: false, anon_select: false, service_insert: true })
  })

  it('lets the service role log a mail and refuses an unknown kind', async () => {
    await asRole('service_role', a.userId)
    const inserted = await client.query(
      `INSERT INTO bank_switch_notifications(company_id, kind, recipient_count) VALUES ($1, 'announcement', 2) RETURNING id, sent_at`,
      [a.companyId],
    )
    expect(inserted.rows[0].id).toBeTruthy()
    expect(inserted.rows[0].sent_at).toBeInstanceOf(Date)
    await client.query('SAVEPOINT bad_kind')
    await expect(
      client.query(`INSERT INTO bank_switch_notifications(company_id, kind) VALUES ($1, 'nagging')`, [a.companyId]),
    ).rejects.toMatchObject({ code: '23514' })
    await client.query('ROLLBACK TO SAVEPOINT bad_kind')
  })

  it('logs the sunset mail (the day the old feed stops) under its own kind (migration 20261014130000)', async () => {
    await asRole('service_role', a.userId)
    const inserted = await client.query(
      `INSERT INTO bank_switch_notifications(company_id, kind, recipient_count) VALUES ($1, 'sunset', 1) RETURNING kind`,
      [a.companyId],
    )
    expect(inserted.rows[0].kind).toBe('sunset')
    // The restated CHECK still lists every earlier kind.
    for (const kind of ['announcement', 'reminder_14', 'reminder_7', 'reminder_3', 'reminder_1', 'byra_nudge']) {
      await client.query(`INSERT INTO bank_switch_notifications(company_id, kind) VALUES ($1, $2)`, [a.companyId, kind])
    }
  })

  it('refuses an authenticated member even of the company itself', async () => {
    await asRole('authenticated', a.userId)
    await expect(
      client.query(`INSERT INTO bank_switch_notifications(company_id, kind) VALUES ($1, 'announcement')`, [a.companyId]),
    ).rejects.toMatchObject({ code: '42501' })
  })
})

describe('bank_switch_progress()', () => {
  it('classifies every Enable Banking row once: pending, uncovered or switched, per company and per bank', async () => {
    // Company A: Swedbank pending, Wise uncovered, a superseded SEB row (switched by the dialog).
    const opSeb = await connection({ company: a, aggregator: 'open_payments', bank: 'SEB' })
    await connection({ company: a, aggregator: 'enable_banking', bank: 'Swedbank' })
    await connection({ company: a, aggregator: 'enable_banking', bank: 'Wise' })
    await connection({ company: a, aggregator: 'enable_banking', bank: 'SEB', status: 'revoked', supersededBy: opSeb })
    // Company B: connected Nordea anew through Open Payments (the Enable Banking row still active: switched by name),
    // plus a Nordea First Card row, which the uncovered list claims before the name match can.
    await connection({ company: b, aggregator: 'open_payments', bank: 'Nordea' })
    await connection({ company: b, aggregator: 'enable_banking', bank: 'Nordea Bank Abp' })
    await connection({ company: b, aggregator: 'enable_banking', bank: 'Nordea First Card' })
    // Noise the counter must ignore: an abandoned Open Payments attempt, an expired Enable Banking row, a revoked one nobody superseded.
    await connection({ company: a, aggregator: 'open_payments', bank: 'Swedbank', status: 'pending' })
    await connection({ company: b, aggregator: 'enable_banking', bank: 'Handelsbanken', status: 'expired' })
    await connection({ company: b, aggregator: 'enable_banking', bank: 'Danske Bank', status: 'revoked' })

    await asRole('service_role', a.userId)
    const result = await progress()
    // Other suites' committed companies may hold rows too, so the company and
    // connection totals are checked as lower bounds and the banks exactly.
    expect(result.companies.pending).toBeGreaterThanOrEqual(1)
    expect(result.companies.uncovered).toBeGreaterThanOrEqual(1)
    expect(result.connections.pending).toBeGreaterThanOrEqual(1)
    expect(result.connections.uncovered).toBeGreaterThanOrEqual(2)
    expect(result.connections.switched).toBeGreaterThanOrEqual(2)
    const banks = new Map((result.banks as Array<{ bank: string; pending: number; uncovered: number; switched: number }>).map((row) => [row.bank, row]))
    expect(banks.get('Swedbank')).toMatchObject({ pending: expect.any(Number), uncovered: 0 })
    expect(banks.get('Swedbank')!.pending).toBeGreaterThanOrEqual(1)
    expect(banks.get('Wise')).toMatchObject({ pending: 0, switched: 0 })
    expect(banks.get('Wise')!.uncovered).toBeGreaterThanOrEqual(1)
    expect(banks.get('SEB')!.switched).toBeGreaterThanOrEqual(1)
    expect(banks.get('Nordea Bank Abp')!.switched).toBeGreaterThanOrEqual(1)
    expect(banks.get('Nordea First Card')!.uncovered).toBeGreaterThanOrEqual(1)
    expect(banks.has('Handelsbanken')).toBe(false)
    expect(banks.has('Danske Bank')).toBe(false)
  })

  it('counts a company as done once nothing is pending or uncovered, and treats every bank as covered without the list', async () => {
    const op = await connection({ company: a, aggregator: 'open_payments', bank: 'Swedbank' })
    await connection({ company: a, aggregator: 'enable_banking', bank: 'Swedbank', status: 'revoked', supersededBy: op })
    await connection({ company: b, aggregator: 'enable_banking', bank: 'Wise' })
    await asRole('service_role', a.userId)
    const withList = await progress(['wise'])
    expect(withList.companies.done).toBeGreaterThanOrEqual(1)
    expect(withList.connections.uncovered).toBeGreaterThanOrEqual(1)
    const bare = await progress([])
    const wise = (bare.banks as Array<{ bank: string; pending: number; uncovered: number }>).find((row) => row.bank === 'Wise')
    expect(wise?.uncovered).toBe(0)
    expect(wise!.pending).toBeGreaterThanOrEqual(1)
  })

  it('is service role only', async () => {
    const privileges = await getPool().query<{ anon: boolean; authenticated: boolean; service: boolean }>(`
      SELECT has_function_privilege('anon', 'public.bank_switch_progress(text[])', 'EXECUTE') AS anon,
             has_function_privilege('authenticated', 'public.bank_switch_progress(text[])', 'EXECUTE') AS authenticated,
             has_function_privilege('service_role', 'public.bank_switch_progress(text[])', 'EXECUTE') AS service`)
    expect(privileges.rows[0]).toEqual({ anon: false, authenticated: false, service: true })
    await asRole('authenticated', a.userId)
    await expect(progress()).rejects.toMatchObject({ code: '42501' })
  })
})
