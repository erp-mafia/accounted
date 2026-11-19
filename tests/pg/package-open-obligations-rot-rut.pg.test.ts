/**
 * A ROT/RUT begäran whose payout is not booked yet keeps Kundfakturor open
 * (migration 20261017140000 and the obligation probe in
 * src/lib/modules/obligations.ts), against real Postgres:
 *
 *   - package_open_obligations (and package_usage, which the hide-unused
 *     detector reads) names open_rot_rut_payout_requests for a generated,
 *     submitted, paid or partially paid begäran without a settlement
 *     voucher, and not for a settled, rejected or cancelled one;
 *   - a company that switched Kundfakturor off while a begäran is pending
 *     reads it winding_down, through the TypeScript probe on the real
 *     schema, and off once the payout is booked;
 *   - the bank ingest gate's read (readPackagesOff, behind
 *     INGEST_PACKAGE_GATING) counts Kundfakturor fully off only then, so its
 *     ROT/RUT matchers keep running while the payout is still to come.
 *
 * Only the HTTP hop to PostgREST is replaced (./postgrest-over-pg.ts).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'crypto'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { loadCompanyCapabilities } from '@/lib/modules/capabilities'
import { readPackagesOff } from '@/lib/modules/packages-off'
import { insertDraftJournalEntry, seedCompany } from './fixtures'
import { getPool, runAsServiceRole } from './setup'
import type { PgRest } from './postgrest-over-pg'

const shim = vi.hoisted(() => ({ rest: null as PgRest | null }))

class UnusedRealtimeTransport {
  constructor() {
    throw new Error('pg-real: realtime is not used')
  }
}

vi.mock('@/lib/supabase/service-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/supabase/service-client')>()
  const { createPgRest } = await import('./postgrest-over-pg')
  shim.rest ??= createPgRest({ role: 'service_role' })
  return {
    ...actual,
    createServiceRoleClient: (_url: string, _key: string, options?: Parameters<typeof actual.createServiceRoleClient>[2]) =>
      actual.createServiceRoleClient('http://pg-real.invalid', 'pg-real-service-role', {
        ...options,
        global: { ...options?.global, fetch: shim.rest!.fetch },
        realtime: { transport: UnusedRealtimeTransport as never },
      }),
  }
})

afterEach(() => {
  expect(shim.rest?.unsupported.splice(0) ?? []).toEqual([])
})

async function insertRequest(params: { companyId: string; userId: string; status: string }): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.rot_rut_payout_requests (id, company_id, user_id, deduction_type, name, status, requested_total, file_name)
     VALUES ($1, $2, $3, 'rot', 'BEGARAN 1', $4, 6750, 'rot-begaran.xml')`,
    [id, params.companyId, params.userId, params.status],
  )
  return id
}

async function openObligations(companyId: string, packageId: string): Promise<string[]> {
  return runAsServiceRole(async (client) => {
    const { rows } = await client.query<{ open: string[] }>(`SELECT public.package_open_obligations($1, $2) AS open`, [
      companyId,
      packageId,
    ])
    return rows[0].open
  })
}

describe('package_open_obligations: a ROT/RUT begäran awaiting its payout', () => {
  it('names a begäran in every open status, and not one that is rejected or cancelled', async () => {
    for (const status of ['generated', 'submitted', 'paid', 'partially_paid']) {
      const { userId, companyId } = await seedCompany()
      await insertRequest({ companyId, userId, status })
      expect(await openObligations(companyId, 'customer-invoices'), status).toEqual(['open_rot_rut_payout_requests'])
      // Only Kundfakturor owns it.
      expect(await openObligations(companyId, 'supplier-invoices-and-payments'), status).toEqual([])
    }
    for (const status of ['rejected', 'cancelled']) {
      const { userId, companyId } = await seedCompany()
      await insertRequest({ companyId, userId, status })
      expect(await openObligations(companyId, 'customer-invoices'), status).toEqual([])
    }
  })

  it('stops naming it once the payout is booked, and package_usage carries it', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const requestId = await insertRequest({ companyId, userId, status: 'paid' })

    const usage = async () =>
      runAsServiceRole(async (client) => {
        const { rows } = await client.query<{ open_obligations: string[] }>(
          `SELECT open_obligations FROM public.package_usage($1, now() - interval '6 months') WHERE package_id = 'customer-invoices'`,
          [companyId],
        )
        return rows[0].open_obligations
      })
    expect(await usage()).toEqual(['open_rot_rut_payout_requests'])

    const voucherId = await insertDraftJournalEntry({
      userId,
      companyId,
      fiscalPeriodId,
      sourceType: 'rot_rut_payout',
      sourceId: requestId,
    })
    await getPool().query(`UPDATE public.rot_rut_payout_requests SET settlement_journal_entry_id = $1 WHERE id = $2`, [
      voucherId,
      requestId,
    ])
    expect(await openObligations(companyId, 'customer-invoices')).toEqual([])
    expect(await usage()).toEqual([])
  })
})

describe('winding down: Kundfakturor switched off with a begäran pending', () => {
  it('reads winding_down while the payout is still to come, and off once it is booked', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const requestId = await insertRequest({ companyId, userId, status: 'submitted' })
    const switched = await runAsServiceRole(async (client) => {
      const { rows } = await client.query<{ result: Record<string, unknown> }>(
        `SELECT public.set_company_package_choice($1, 'customer-invoices', false, 'company', $2) AS result`,
        [companyId, userId],
      )
      return rows[0].result
    })
    expect(switched).toMatchObject({ ok: true, enabled: false })

    const supabase = createServiceClientNoCookies()
    const customerInvoices = async () => (await loadCompanyCapabilities(supabase, companyId))!.packages.find((p) => p.id === 'customer-invoices')!
    expect(await customerInvoices()).toMatchObject({
      availability: 'winding_down',
      reasons: ['turned_off_by_company', 'open_obligations'],
      open_obligations: ['open_rot_rut_payout_requests'],
    })

    const voucherId = await insertDraftJournalEntry({
      userId,
      companyId,
      fiscalPeriodId,
      sourceType: 'rot_rut_payout',
      sourceId: requestId,
    })
    await getPool().query(
      `UPDATE public.rot_rut_payout_requests SET status = 'paid', decided_total = 6750, settlement_journal_entry_id = $1 WHERE id = $2`,
      [voucherId, requestId],
    )
    expect(await customerInvoices()).toMatchObject({ availability: 'off', open_obligations: [] })
  })

  it('reads off at once when the only begäran was rejected', async () => {
    const { userId, companyId } = await seedCompany()
    await insertRequest({ companyId, userId, status: 'rejected' })
    await runAsServiceRole((client) =>
      client.query(`SELECT public.set_company_package_choice($1, 'customer-invoices', false, 'company', $2)`, [companyId, userId]),
    )
    const pkg = (await loadCompanyCapabilities(createServiceClientNoCookies(), companyId))!.packages.find(
      (p) => p.id === 'customer-invoices',
    )!
    expect(pkg).toMatchObject({ availability: 'off', open_obligations: [] })
  })
})

describe('readPackagesOff (the bank ingest gate) on the real schema', () => {
  it('keeps Kundfakturor out of the off set while a begäran is pending, and counts it once the payout is booked', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const supabase = createServiceClientNoCookies()
    const packages = ['customer-invoices', 'supplier-invoices-and-payments'] as const

    // Every package on: nothing off.
    expect([...(await readPackagesOff(supabase, companyId, packages))!]).toEqual([])

    const requestId = await insertRequest({ companyId, userId, status: 'submitted' })
    await runAsServiceRole((client) =>
      client.query(`SELECT public.set_company_package_choice($1, 'customer-invoices', false, 'company', $2)`, [companyId, userId]),
    )
    // Switched off, but the payout is still to come: winding down, not off.
    expect([...(await readPackagesOff(supabase, companyId, packages))!]).toEqual([])

    const voucherId = await insertDraftJournalEntry({
      userId,
      companyId,
      fiscalPeriodId,
      sourceType: 'rot_rut_payout',
      sourceId: requestId,
    })
    await getPool().query(`UPDATE public.rot_rut_payout_requests SET settlement_journal_entry_id = $1 WHERE id = $2`, [
      voucherId,
      requestId,
    ])
    expect([...(await readPackagesOff(supabase, companyId, packages))!]).toEqual(['customer-invoices'])
  })
})
