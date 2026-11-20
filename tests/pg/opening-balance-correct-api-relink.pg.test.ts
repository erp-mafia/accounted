/**
 * Correcting a year's ingående balans (IB) through the API doors, end to end
 * against the real schema: the v1 route
 * (POST /fiscal-periods/{id}/opening-balances/correct) with an API key, and the
 * MCP tool gnubok_correct_opening_balances, staged and then approved with
 * gnubok_approve_pending_operation (commitPendingOperation, the staged
 * executor). Both run on the cookieless service-role client.
 *
 * Before 20261018200000 the relink RPC (replace_period_opening_balance_link)
 * read the caller's role from auth.uid(), which is NULL there: the relink was
 * refused after the old IB was already stornoed, the compensation stornoed the
 * corrected IB as well, and the year was left with no live IB. Pinned here for
 * both doors: the correction succeeds, the year is linked to the corrected IB
 * (opening_balances_set true), the old IB is stornoed (reversed, with one
 * storno verifikat), exactly one IB of the year is live, and
 * detect_voucher_gaps finds no gap. A member's key is still refused at both
 * doors, with nothing booked or staged.
 *
 * What is not real: the HTTP hop to PostgREST, replaced by
 * tests/pg/postgrest-over-pg.ts as in phase1-exit-check.pg.test.ts (every
 * request must stay inside the shim's grammar, asserted after each test); the
 * Next.js runtime (route handlers are called as functions).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServiceClientNoCookies, generateApiKey } from '@/lib/auth/api-keys'
import { POST as manualRoute } from '@/app/api/v1/companies/[companyId]/fiscal-periods/[id]/opening-balances/manual/route'
import { POST as correctRoute } from '@/app/api/v1/companies/[companyId]/fiscal-periods/[id]/opening-balances/correct/route'
import { tools } from '@/extensions/general/mcp-server/server'
import { insertAuthUser, insertCompanyMember, insertFiscalPeriod, seedCompany } from './fixtures'
import { getPool } from './setup'
import type { PgRest } from './postgrest-over-pg'

const shim = vi.hoisted(() => ({ rest: null as PgRest | null }))

/** supabase-js resolves a WebSocket constructor eagerly; nothing here subscribes. */
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
vi.mock('@/lib/supabase/server', async (importOriginal) => {
  const serviceClient = await import('@/lib/supabase/service-client')
  return {
    ...(await importOriginal<typeof import('@/lib/supabase/server')>()),
    createServiceClient: () => serviceClient.createServiceRoleClient('', ''),
    createClient: async () => {
      throw new Error('pg-real: no request scope (cookie session) in this test')
    },
  }
})

afterEach(() => {
  const unsupported = shim.rest?.unsupported.splice(0) ?? []
  expect(unsupported).toEqual([])
})

const SCOPES = ['companies:read', 'reports:read', 'bookkeeping:write', 'pending_operations:approve']
const IB_LINES = [
  { account_number: '1930', amount: 100000 },
  { account_number: '1510', amount: 20000 },
  { account_number: '2081', amount: -25000 },
  { account_number: '2440', amount: -15000 },
  { account_number: '2091', amount: -80000 },
]
/** 1 500 kronor less in the bank and on 2440: a supplier paid before the year began. */
const IB_CORRECTED = [
  { account_number: '1930', amount: 98500 },
  { account_number: '1510', amount: 20000 },
  { account_number: '2081', amount: -25000 },
  { account_number: '2440', amount: -13500 },
  { account_number: '2091', amount: -80000 },
]

const correctTool = tools.find((t) => t.name === 'gnubok_correct_opening_balances')!
const approveTool = tools.find((t) => t.name === 'gnubok_approve_pending_operation')!

let idempotencyCounter = 0

function request(path: string, key: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `pg-ib-relink-${Date.now()}-${idempotencyCounter++}`,
    },
    body: JSON.stringify(body),
  })
}

const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) })

interface Key {
  userId: string
  apiKeyId: string
  key: string
}

interface World {
  companyId: string
  year2026: string
  year2027: string
  owner: Key
}

/** A person's key as Settings > API keys stores one: the SHA-256 of a real gnubok_sk_ secret. */
async function insertKey(userId: string, companyId: string, name: string): Promise<Key> {
  const minted = generateApiKey('live')
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.api_keys (user_id, company_id, key_hash, key_prefix, name, scopes, sod_acknowledged_at, sod_acknowledged_by)
     VALUES ($1, $2, $3, $4, $5, $6, now(), $1) RETURNING id::text AS id`,
    [userId, companyId, minted.hash, minted.prefix, name, SCOPES],
  )
  return { userId, apiKeyId: rows[0]!.id, key: minted.key }
}

async function seedWorld(): Promise<World> {
  const { userId, companyId, fiscalPeriodId } = await seedCompany()
  const year2027 = await insertFiscalPeriod({ userId, companyId, name: '2027', periodStart: '2027-01-01', periodEnd: '2027-12-31' })
  return { companyId, year2026: fiscalPeriodId, year2027, owner: await insertKey(userId, companyId, 'Bokföringsbyrån') }
}

function mcpActor(k: Key) {
  return { type: 'api_key' as const, id: k.apiKeyId, label: 'Bokföringsbyrån', unattendedCommitLimit: null, allowedCompanyIds: null }
}

/** The year's IB through the v1 door, as a company new to Accounted types it. */
async function setIB(w: World, periodId: string): Promise<string> {
  const response = await manualRoute(
    request(`/api/v1/companies/${w.companyId}/fiscal-periods/${periodId}/opening-balances/manual`, w.owner.key, { lines: IB_LINES }),
    params({ companyId: w.companyId, id: periodId }),
  )
  const body = (await response.json()) as { data: { journal_entry_id: string } }
  expect(response.status, JSON.stringify(body)).toBe(201)
  return body.data.journal_entry_id
}

interface YearState {
  pointer: string | null
  set: boolean
  liveIB: string[]
  oldStatus: string
  stornos: Array<{ status: string; reverses_id: string }>
  gaps: unknown[]
}

async function yearState(w: World, periodId: string, oldEntryId: string): Promise<YearState> {
  const year = await getPool().query<{ pointer: string | null; set: boolean }>(
    `SELECT opening_balance_entry_id::text AS pointer, opening_balances_set AS set FROM public.fiscal_periods WHERE id = $1`,
    [periodId],
  )
  const live = await getPool().query<{ id: string }>(
    `SELECT id::text AS id FROM public.journal_entries
      WHERE fiscal_period_id = $1 AND source_type = 'opening_balance' AND status = 'posted'`,
    [periodId],
  )
  const old = await getPool().query<{ status: string }>(`SELECT status FROM public.journal_entries WHERE id = $1`, [oldEntryId])
  const stornos = await getPool().query<{ status: string; reverses_id: string }>(
    `SELECT status, reverses_id::text AS reverses_id FROM public.journal_entries
      WHERE fiscal_period_id = $1 AND source_type = 'storno' ORDER BY voucher_number`,
    [periodId],
  )
  const gaps = await getPool().query(`SELECT * FROM public.detect_voucher_gaps($1, $2, 'A')`, [w.companyId, periodId])
  return {
    pointer: year.rows[0]!.pointer,
    set: year.rows[0]!.set,
    liveIB: live.rows.map((r) => r.id),
    oldStatus: old.rows[0]!.status,
    stornos: stornos.rows,
    gaps: gaps.rows,
  }
}

async function entryCount(companyId: string): Promise<number> {
  const { rows } = await getPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM public.journal_entries WHERE company_id = $1`, [
    companyId,
  ])
  return rows[0]!.n
}

describe('correcting an IB through the v1 and MCP doors (service role) relinks the year (pg)', () => {
  it('v1: the corrected IB is booked and linked, the old one stornoed, no gap', async () => {
    const w = await seedWorld()
    const oldEntry = await setIB(w, w.year2026)

    const response = await correctRoute(
      request(`/api/v1/companies/${w.companyId}/fiscal-periods/${w.year2026}/opening-balances/correct`, w.owner.key, {
        lines: IB_CORRECTED,
      }),
      params({ companyId: w.companyId, id: w.year2026 }),
    )
    const body = (await response.json()) as { data: { journal_entry_id: string; reversed_entry_id: string; total_debit: number } }
    expect(response.status, JSON.stringify(body)).toBe(201)
    expect(body.data).toMatchObject({ reversed_entry_id: oldEntry, total_debit: 118500 })
    const newEntry = body.data.journal_entry_id

    expect(await yearState(w, w.year2026, oldEntry)).toEqual({
      pointer: newEntry,
      set: true,
      liveIB: [newEntry],
      oldStatus: 'reversed',
      stornos: [{ status: 'posted', reverses_id: oldEntry }],
      gaps: [],
    })
  })

  it('MCP: staged, then approved through the staged executor: the corrected IB is booked and linked, the old one stornoed, no gap', async () => {
    const w = await seedWorld()
    const oldEntry = await setIB(w, w.year2027)
    const supabase = createServiceClientNoCookies()
    const actor = mcpActor(w.owner)

    const staged = (await correctTool.execute(
      { fiscal_period_id: w.year2027, lines: IB_CORRECTED },
      w.companyId,
      w.owner.userId,
      supabase,
      actor,
    )) as { staged: boolean; operation_id: string }
    expect(staged).toMatchObject({ staged: true, operation_id: expect.any(String) })
    // Staging books nothing.
    expect(await entryCount(w.companyId)).toBe(1)

    const approved = (await approveTool.execute(
      { operation_id: staged.operation_id, confirmed: true },
      w.companyId,
      w.owner.userId,
      supabase,
      actor,
    )) as { status: string; data?: { journal_entry_id?: string; reversed_entry_id?: string } }
    expect(approved, JSON.stringify(approved)).toMatchObject({ status: 'committed', data: { reversed_entry_id: oldEntry } })
    const newEntry = approved.data!.journal_entry_id!

    expect(await yearState(w, w.year2027, oldEntry)).toEqual({
      pointer: newEntry,
      set: true,
      liveIB: [newEntry],
      oldStatus: 'reversed',
      stornos: [{ status: 'posted', reverses_id: oldEntry }],
      gaps: [],
    })
    const operation = await getPool().query(`SELECT status FROM public.pending_operations WHERE id = $1`, [staged.operation_id])
    expect(operation.rows[0]).toEqual({ status: 'committed' })
  })

  it('a member key is refused at both doors before anything is booked or staged: the year keeps its IB', async () => {
    const w = await seedWorld()
    const oldEntry = await setIB(w, w.year2026)
    const memberId = await insertAuthUser()
    await insertCompanyMember({ companyId: w.companyId, userId: memberId, role: 'member' })
    const member = await insertKey(memberId, w.companyId, 'Medarbetarens nyckel')
    const before = await yearState(w, w.year2026, oldEntry)

    const response = await correctRoute(
      request(`/api/v1/companies/${w.companyId}/fiscal-periods/${w.year2026}/opening-balances/correct`, member.key, {
        lines: IB_CORRECTED,
      }),
      params({ companyId: w.companyId, id: w.year2026 }),
    )
    const body = (await response.json()) as { error: { code: string } }
    expect(response.status, JSON.stringify(body)).toBe(403)
    expect(body.error.code).toBe('FORBIDDEN')

    await expect(
      correctTool.execute(
        { fiscal_period_id: w.year2026, lines: IB_CORRECTED },
        w.companyId,
        memberId,
        createServiceClientNoCookies(),
        mcpActor(member),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })

    expect(await entryCount(w.companyId)).toBe(1)
    expect(await yearState(w, w.year2026, oldEntry)).toEqual(before)
    expect(before).toMatchObject({ pointer: oldEntry, set: true, liveIB: [oldEntry], oldStatus: 'posted', stornos: [] })
    const staged = await getPool().query(`SELECT count(*)::int AS n FROM public.pending_operations WHERE company_id = $1`, [w.companyId])
    expect(staged.rows[0]).toEqual({ n: 0 })
  })
})
