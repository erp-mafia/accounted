/**
 * Attest levels (#135, migration 20261030140000): a limit per person and two
 * attesters from an amount, applied by the database when an approval is
 * recorded (attest_supplier_invoice, supplier_invoice_attest_ruling).
 *
 *   1. the SQL rules and the TypeScript rules (attest-policy.ts) agree, case
 *      by case, as company-grants proves for grant_names_counterparty;
 *   2. one step: an attester whose limit covers the invoice attests it alone,
 *      one whose limit does not is refused and nothing is written;
 *   3. two steps: two different attesters in any order, at least one with a
 *      covering limit; the same person twice and two without a covering
 *      limit are refused; payment holds the invoice until the second;
 *   4. concurrent attests take turns on the invoice: the last one sees the
 *      others and the marker is set once;
 *   5. every door: the dashboard (the service role naming the signed-in
 *      user), the mail's link, v1 and MCP, with the key capped by the lower
 *      of the person's limit and the key's ceiling; a session calling the
 *      function itself cannot attest as someone else;
 *   6. the policy and its limits are saved together, by an owner or admin
 *      only, and every limit change is in audit_log.
 *
 * What is not real: the HTTP hop to PostgREST, replaced by
 * tests/pg/postgrest-over-pg.ts as in supplier-invoice-attest-marker.pg.test.ts.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { PoolClient } from 'pg'
import { createServiceClientNoCookies, generateApiKey } from '@/lib/auth/api-keys'
import { commitPendingOperation } from '@/lib/pending-operations/commit'
import { mintAttestLink } from '@/lib/supplier-invoices/attest-links'
import { deciderRefusal } from '@/lib/supplier-invoices/attest-service'
import { loadAttestBlockedInvoiceIds } from '@/lib/supplier-invoices/attest-policy-read'
import { ruleOnApproval, type AttestationRecord, type AttestPolicy } from '@/lib/supplier-invoices/attest-policy'
import type { PendingOperation } from '@/types'
import { tools } from '@/extensions/general/mcp-server/server'
import type { ActorContext } from '@/extensions/general/mcp-server/server'
import { POST as approveRoute } from '@/app/api/supplier-invoices/[id]/approve/route'
import { POST as rejectRoute } from '@/app/api/supplier-invoices/[id]/reject/route'
import { PUT as savePolicyRoute } from '@/app/api/supplier-invoices/attest-policy/route'
import { POST as v1ApproveRoute } from '@/app/api/v1/companies/[companyId]/supplier-invoices/[id]/approve/route'
import { POST as attestDecisionRoute } from '@/app/api/attest/[token]/decision/route'
import { insertAuthUser, insertCompanyMember, seedCompany, setActiveCompany } from './fixtures'
import { getClient, getPool, withUserContext } from './setup'
import { createPgRest, type PgRest } from './postgrest-over-pg'

const shim = vi.hoisted(() => ({ rest: null as PgRest | null }))
/** Who the dashboard doors run as, and the session client they get (memberClient, set below). */
const session = vi.hoisted(() => ({ userId: '', companyId: '', client: null as null | ((userId: string) => SupabaseClient) }))

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
// The dashboard doors: the signed-in member on their own session, through RLS.
vi.mock('@/lib/auth/require-auth', async () => ({
  requireAuth: async () => ({ user: { id: session.userId }, supabase: session.client!(session.userId), error: null }),
}))
vi.mock('@/lib/company/context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/company/context')>()),
  getActiveCompanyId: async () => session.companyId,
  requireCompanyId: async () => session.companyId,
}))
vi.mock('@/lib/auth/require-write', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/require-write')>()),
  requireWritePermission: async () => ({ ok: true }),
}))

const memberShims: PgRest[] = []

/** A supabase-js client acting as a signed-in member, through RLS: what PostgREST gives a browser session. */
function memberClient(userId: string): SupabaseClient {
  const rest = createPgRest({ role: 'authenticated', userId })
  memberShims.push(rest)
  return createClient('http://pg-real.invalid', 'pg-real-anon', {
    global: { fetch: rest.fetch },
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { transport: UnusedRealtimeTransport as never },
  })
}
session.client = memberClient

afterEach(() => {
  const unsupported = [...(shim.rest?.unsupported.splice(0) ?? []), ...memberShims.flatMap((r) => r.unsupported.splice(0))]
  memberShims.length = 0
  expect(unsupported).toEqual([])
})

/**
 * A company under faktureringsmetoden with the people of the issue: the
 * owner (an admin of the books), Anna the controller, Bo the CEO, Cilla who
 * registers the invoices, and Vera, a viewer (the external bookkeeper who
 * only reads).
 */
interface World {
  ownerId: string
  annaId: string
  boId: string
  cillaId: string
  veraId: string
  companyId: string
  supplierId: string
}

async function seedWorld(): Promise<World> {
  const { userId: ownerId, companyId } = await seedCompany()
  const [annaId, boId, cillaId, veraId] = [await insertAuthUser(), await insertAuthUser(), await insertAuthUser(), await insertAuthUser()]
  for (const userId of [annaId, boId, cillaId]) await insertCompanyMember({ companyId, userId, role: 'member' })
  await insertCompanyMember({ companyId, userId: veraId, role: 'viewer' })
  for (const id of [ownerId, annaId, boId, cillaId, veraId]) await setActiveCompany(id, companyId)
  await getPool().query(
    `INSERT INTO public.company_settings (company_id, entity_type, vat_registered, accounting_method)
     VALUES ($1, 'aktiebolag', true, 'accrual')
     ON CONFLICT (company_id) DO UPDATE SET accounting_method = EXCLUDED.accounting_method`,
    [companyId],
  )
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.suppliers (user_id, company_id, name) VALUES ($1, $2, 'Kontorsvaror AB') RETURNING id::text`,
    [ownerId, companyId],
  )
  return { ownerId, annaId, boId, cillaId, veraId, companyId, supplierId: rows[0]!.id }
}

const INSERT_INVOICE = `INSERT INTO public.supplier_invoices
   (id, user_id, company_id, supplier_id, arrival_number, supplier_invoice_number, invoice_date, due_date,
    subtotal, vat_amount, total, remaining_amount, currency, total_sek, exchange_rate)
 VALUES ($1, $2, $3, $4, floor(random() * 1000000)::int, $5, '2026-10-01', '2099-12-31', $6, $7, $8, $8, $9, $10, $11)`

/** An unattested invoice Cilla registered, due well ahead. */
async function registeredInvoice(w: World, total: number, db: Pick<PoolClient, 'query'> = getPool()): Promise<string> {
  const id = randomUUID()
  await db.query(INSERT_INVOICE, [id, w.cillaId, w.companyId, w.supplierId, `F-${id.slice(0, 8)}`, total * 0.8, total * 0.2, total, 'SEK', null, null])
  return id
}

/**
 * The policy of the issue, as an owner saves it: Anna and Bo attest, Anna up
 * to `annaLimit` kr, Bo without a limit, and two attesters from `twoStep` kr.
 */
async function policy(w: World, options: { annaLimit?: number | null; twoStep?: number | null; mode?: 'any' | 'all'; attesters?: string[] } = {}): Promise<void> {
  await getPool().query(
    `INSERT INTO public.company_attest_policies (company_id, enabled, threshold_amount, mode, attesters, preparer_may_attest, two_step_from_sek, updated_by)
     VALUES ($1, true, NULL, $2, $3::uuid[], false, $4, $5)`,
    [w.companyId, options.mode ?? 'any', options.attesters ?? [w.annaId, w.boId], options.twoStep ?? null, w.ownerId],
  )
  if (options.annaLimit !== undefined) {
    await getPool().query(
      `INSERT INTO public.company_attest_limits (company_id, user_id, scope, max_amount_sek, updated_by) VALUES ($1, $2, 'supplier_invoice', $3, $4)`,
      [w.companyId, w.annaId, options.annaLimit, w.ownerId],
    )
  }
}

interface MarkerRow {
  status: string
  approved_at: Date | null
  approved_by: string | null
}

async function marker(invoiceId: string): Promise<MarkerRow> {
  const { rows } = await getPool().query<MarkerRow>(`SELECT status, approved_at, approved_by FROM public.supplier_invoices WHERE id = $1`, [invoiceId])
  return rows[0]!
}

interface TrailRow {
  user_id: string
  decision: string
  source: string
  step: number | null
  limit_sek: string | null
  amount_sek: string | null
}

async function trail(invoiceId: string): Promise<TrailRow[]> {
  const { rows } = await getPool().query<TrailRow>(
    `SELECT user_id::text, decision, source, step, limit_sek::text, amount_sek::text
       FROM public.supplier_invoice_attestations WHERE supplier_invoice_id = $1 ORDER BY decided_at, step NULLS LAST`,
    [invoiceId],
  )
  return rows
}

function params<T extends Record<string, string>>(value: T): { params: Promise<T> } {
  return { params: Promise.resolve(value) }
}

async function json(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text()
  return text ? (JSON.parse(text) as Record<string, unknown>) : {}
}

/** The dashboard's Attestera, as `userId`. */
async function approveInApp(w: World, userId: string, invoiceId: string): Promise<Response> {
  session.userId = userId
  session.companyId = w.companyId
  return approveRoute(new Request(`http://localhost/api/supplier-invoices/${invoiceId}/approve`, { method: 'POST' }), params({ id: invoiceId }))
}

/** The dashboard's Neka, as `userId`. */
async function rejectInApp(w: World, userId: string, invoiceId: string): Promise<Response> {
  session.userId = userId
  session.companyId = w.companyId
  return rejectRoute(
    new Request(`http://localhost/api/supplier-invoices/${invoiceId}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ comment: 'Fel belopp' }),
    }),
    params({ id: invoiceId }),
  )
}

/** The attester's Godkänn from the mail. */
async function approveByLink(w: World, userId: string, invoiceId: string): Promise<Response> {
  const link = await mintAttestLink(createServiceClientNoCookies(), { companyId: w.companyId, invoiceId, attesterUserId: userId })
  return attestDecisionRoute(
    new Request(`http://localhost/api/attest/${link.token}/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' }),
    }),
    params({ token: link.token }),
  )
}

async function blocked(w: World, invoiceId: string): Promise<boolean> {
  return (await loadAttestBlockedInvoiceIds(createServiceClientNoCookies(), w.companyId, [invoiceId])).has(invoiceId)
}

/** A deterministic sequence in [0, 1). */
function sequence(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

describe('the SQL rules and the TypeScript rules agree', () => {
  it('rules alike on generated cases: policy, limits, two steps, rounds, registrant, members and keys', async () => {
    const w = await seedWorld()
    const departed = await insertAuthUser()
    const people = [w.ownerId, w.annaId, w.boId, w.cillaId, w.veraId, departed]
    const writers = new Set([w.ownerId, w.annaId, w.boId, w.cillaId])
    // Whose attest can count: those who keep the books, and Vera, the viewer (crm#1569).
    const members = { attesters: new Set([...writers, w.veraId]), writers }
    const random = sequence(135)
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)]!
    const mismatches: unknown[] = []
    const outcomes = new Set<string>()

    const client = await getClient()
    try {
      for (let i = 0; i < 220; i++) {
        await client.query('BEGIN')
        const method = pick(['accrual', 'accrual', 'accrual', 'cash'])
        await client.query(`UPDATE public.company_settings SET accounting_method = $2 WHERE company_id = $1`, [w.companyId, method])
        const attesters = people.filter(() => random() < 0.55)
        const enabled = attesters.length > 0 && random() < 0.9
        const twoStep = enabled && attesters.length >= 2 && random() < 0.6 ? pick([0, 20000, 50000, 80000]) : null
        const p: AttestPolicy = {
          enabled,
          threshold_amount: pick([null, null, 1000, 50000]),
          mode: pick(['any', 'any', 'all'] as const),
          attesters,
          preparer_may_attest: random() < 0.3,
          two_step_from_sek: twoStep,
          updated_by: null,
          updated_at: null,
        }
        await client.query(
          `INSERT INTO public.company_attest_policies (company_id, enabled, threshold_amount, mode, attesters, preparer_may_attest, two_step_from_sek, updated_by)
           VALUES ($1, $2, $3, $4, $5::uuid[], $6, $7, $8)`,
          [w.companyId, p.enabled, p.threshold_amount, p.mode, p.attesters, p.preparer_may_attest, p.two_step_from_sek, w.ownerId],
        )
        const limits = new Map<string, number | null>()
        for (const person of people) {
          if (random() < 0.5) continue
          const limit = pick([null, 1, 10000, 50000, 60000, 80000, 100000])
          limits.set(person, limit)
          await client.query(
            `INSERT INTO public.company_attest_limits (company_id, user_id, scope, max_amount_sek, updated_by) VALUES ($1, $2, 'supplier_invoice', $3, $4)`,
            [w.companyId, person, limit, w.ownerId],
          )
        }
        // A reserved scope never counts.
        if (random() < 0.2) {
          await client.query(
            `INSERT INTO public.company_attest_limits (company_id, user_id, scope, max_amount_sek, updated_by)
             VALUES ($1, $2, 'booking_review', 5, $3) ON CONFLICT DO NOTHING`,
            [w.companyId, w.boId, w.ownerId],
          )
        }

        const currency = pick(['SEK', 'SEK', 'SEK', 'EUR'])
        const total = pick([500, 10000, 50000, 60000, 79999.99, 80000, 80000.01, 120000, 1.005, 33.33])
        const invoice = {
          user_id: pick([w.ownerId, w.annaId, w.boId, w.cillaId]),
          is_credit_note: false,
          currency,
          total,
          total_sek: currency === 'EUR' && random() < 0.3 ? total * 11 : null,
          exchange_rate: currency === 'EUR' ? pick([null, 11.5, 10.25]) : null,
        }
        const invoiceId = randomUUID()
        await client.query(INSERT_INVOICE, [
          invoiceId,
          invoice.user_id,
          w.companyId,
          w.supplierId,
          `F-${invoiceId.slice(0, 8)}`,
          total * 0.8,
          total * 0.2,
          total,
          currency,
          invoice.total_sek,
          invoice.exchange_rate,
        ])
        const decisions: AttestationRecord[] = []
        for (let k = Math.floor(random() * 4); k > 0; k--) {
          const row: AttestationRecord = {
            user_id: pick(people),
            decision: random() < 0.8 ? 'approved' : 'rejected',
            decided_at: new Date(Date.UTC(2026, 9, 1, 9, 10 - k)).toISOString(),
          }
          decisions.push(row)
          await client.query(
            `INSERT INTO public.supplier_invoice_attestations (company_id, supplier_invoice_id, user_id, decision, source, decided_at)
             VALUES ($1, $2, $3, $4, 'app', $5)`,
            [w.companyId, invoiceId, row.user_id, row.decision, row.decided_at],
          )
        }

        for (const actor of people) {
          for (const viaKey of [false, true]) {
            const keyCeiling = viaKey ? pick([null, 30000, 70000]) : null
            const { rows } = await client.query<{ r: Record<string, unknown> }>(
              `SELECT public.supplier_invoice_attest_ruling($1, $2, $3, $4, $5) AS r`,
              [w.companyId, invoiceId, actor, viaKey, keyCeiling],
            )
            const sql = rows[0]!.r
            // The attest service: a member whose attest can count first, then the
            // rules, then keeping the books where no policy governs (deciderRefusal).
            const gate = deciderRefusal(members, actor, false)
            const rule = gate ? null : ruleOnApproval(p, method, invoice, decisions, actor, p.enabled ? members.attesters : undefined, { limits, viaKey, keyCeiling })
            const readOnly = rule && rule.kind !== 'refused' ? deciderRefusal(members, actor, rule.kind === 'unrestricted') : null
            const ts: Record<string, unknown> =
              gate || readOnly ? { kind: 'refused', code: 'FORBIDDEN', reason: gate ?? readOnly } : (rule as unknown as Record<string, unknown>)
            const num = (v: unknown) => (v === null || v === undefined ? null : Number(v))
            const shape = (r: Record<string, unknown>, limitKey: string) => ({
              kind: r.kind,
              code: r.code ?? null,
              reason: r.reason ?? null,
              satisfies: r.satisfies ?? null,
              step: num(r.step),
              limit: num(r.kind === 'record' ? r[limitKey] : r.limit_sek),
              amount: r.code === 'ATTEST_LIMIT_EXCEEDED' ? num(r.amount_sek) : null,
            })
            const a = shape(sql, 'limit_sek')
            const b = shape(ts, 'limitSek')
            outcomes.add([a.kind, a.code, a.reason].filter(Boolean).join('/'))
            if (JSON.stringify(a) !== JSON.stringify(b)) mismatches.push({ case: i, actor, viaKey, keyCeiling, sql: a, ts: b })
          }
        }
        await client.query('ROLLBACK')
      }
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
    expect(mismatches.slice(0, 5)).toEqual([])
    // The cases reach every outcome, so agreement is not agreement on a few.
    expect([...outcomes].sort()).toEqual(
      [
        'record',
        'refused/ATTEST_ALREADY_GIVEN',
        'refused/ATTEST_LIMIT_EXCEEDED/key_limit',
        'refused/ATTEST_LIMIT_EXCEEDED/limit',
        'refused/ATTEST_NOT_ALLOWED/not_attester',
        'refused/ATTEST_NOT_ALLOWED/registrant',
        'refused/FORBIDDEN/not_member',
        'refused/FORBIDDEN/read_only',
        'unrestricted',
      ].sort(),
    )
  })
})

describe('one step: an attester whose limit covers the invoice', () => {
  it('attests alone; one whose limit does not cover it is refused and nothing is written', async () => {
    const w = await seedWorld()
    await policy(w, { annaLimit: 50000 })
    const small = await registeredInvoice(w, 30000)
    const large = await registeredInvoice(w, 80000)

    const covered = await approveInApp(w, w.annaId, small)
    expect(covered.status, JSON.stringify(await json(covered.clone()))).toBe(200)
    expect(await json(covered)).toMatchObject({ data: { status: 'approved', attest: { approved: true, required: true, satisfied: true } } })
    expect(await marker(small)).toMatchObject({ status: 'approved', approved_by: w.annaId })
    expect(await trail(small)).toEqual([{ user_id: w.annaId, decision: 'approved', source: 'app', step: 1, limit_sek: '50000.00', amount_sek: '30000.00' }])

    const refused = await approveInApp(w, w.annaId, large)
    expect(refused.status).toBe(403)
    expect(await json(refused)).toMatchObject({ error: { code: 'ATTEST_LIMIT_EXCEEDED' } })
    expect(await marker(large)).toMatchObject({ approved_at: null })
    expect(await trail(large)).toEqual([])
    expect(await blocked(w, large)).toBe(true)

    // The CEO, without a limit, attests it.
    const ceo = await approveInApp(w, w.boId, large)
    expect(ceo.status, JSON.stringify(await json(ceo.clone()))).toBe(200)
    expect(await marker(large)).toMatchObject({ status: 'approved', approved_by: w.boId })
    expect(await blocked(w, large)).toBe(false)
  })

  it('a viewer attests only where the policy names them, and changes nothing else (crm#1569)', async () => {
    const w = await seedWorld()
    await policy(w, { annaLimit: 50000, attesters: [w.annaId, w.boId] })
    const invoiceId = await registeredInvoice(w, 1000)
    // The external bookkeeper who only reads, not named: no attester.
    session.userId = w.veraId
    session.companyId = w.companyId
    const { data, error } = await memberClient(w.veraId).rpc('attest_supplier_invoice', { p_company_id: w.companyId, p_invoice_id: invoiceId })
    expect(error).toBeNull()
    expect(data).toMatchObject({ ok: false, code: 'ATTEST_NOT_ALLOWED', reason: 'not_attester' })
    expect(await trail(invoiceId)).toEqual([])

    // The byrå's client, named: attests in the app as herself, and the policy is met.
    await getPool().query(`UPDATE public.company_attest_policies SET attesters = $2::uuid[] WHERE company_id = $1`, [w.companyId, [w.annaId, w.veraId]])
    const named = await approveInApp(w, w.veraId, invoiceId)
    expect(named.status, JSON.stringify(await json(named.clone()))).toBe(200)
    expect(await json(named)).toMatchObject({ data: { status: 'approved', attest: { approved: true, required: true, satisfied: true } } })
    expect(await marker(invoiceId)).toMatchObject({ status: 'approved', approved_by: w.veraId })
    expect(await trail(invoiceId)).toEqual([{ user_id: w.veraId, decision: 'approved', source: 'app', step: 1, limit_sek: null, amount_sek: '1000.00' }])
    expect(await blocked(w, invoiceId)).toBe(false)

    // And through the mail's link, the same rules.
    const byLink = await registeredInvoice(w, 2000)
    const linked = await approveByLink(w, w.veraId, byLink)
    expect(linked.status, JSON.stringify(await json(linked.clone()))).toBe(200)
    expect(await marker(byLink)).toMatchObject({ status: 'approved', approved_by: w.veraId })

    // No policy governs the invoice: attest is the one click of someone who keeps the books.
    await getPool().query(`UPDATE public.company_attest_policies SET enabled = false WHERE company_id = $1`, [w.companyId])
    const unrestricted = await registeredInvoice(w, 1000)
    const refused = await approveInApp(w, w.veraId, unrestricted)
    expect(refused.status).toBe(403)
    expect(await json(refused)).toMatchObject({ error: { code: 'FORBIDDEN', details: { reason: 'read_only' } } })
    expect(await marker(unrestricted)).toMatchObject({ approved_at: null })
    expect(await trail(unrestricted)).toEqual([])
    const byMember = await approveInApp(w, w.annaId, unrestricted)
    expect(byMember.status, JSON.stringify(await json(byMember.clone()))).toBe(200)

    // Read access stays read access: the invoice itself is still not hers to change.
    const edited = await withUserContext(w.veraId, (client) =>
      client.query(`UPDATE public.supplier_invoices SET supplier_invoice_number = 'ÄNDRAD' WHERE id = $1`, [invoiceId]),
    )
    expect(edited.rowCount).toBe(0)
  })

  it('a viewer rejects in the app only where the policy names them (crm#1569)', async () => {
    const w = await seedWorld()
    await policy(w, { annaLimit: 50000, attesters: [w.annaId, w.boId] })
    const invoiceId = await registeredInvoice(w, 1000)

    // Not named: refused, and nothing is written.
    const refused = await rejectInApp(w, w.veraId, invoiceId)
    expect(refused.status).toBe(403)
    expect(await json(refused)).toMatchObject({ error: { code: 'ATTEST_NOT_ALLOWED', details: { reason: 'not_attester' } } })
    expect(await trail(invoiceId)).toEqual([])

    // Named: her Neka is on the trail, from the app, and the invoice stays unattested.
    await getPool().query(`UPDATE public.company_attest_policies SET attesters = $2::uuid[] WHERE company_id = $1`, [w.companyId, [w.annaId, w.veraId]])
    const named = await rejectInApp(w, w.veraId, invoiceId)
    expect(named.status, JSON.stringify(await json(named.clone()))).toBe(200)
    expect(await trail(invoiceId)).toMatchObject([{ user_id: w.veraId, decision: 'rejected', source: 'app' }])
    expect(await marker(invoiceId)).toMatchObject({ approved_at: null })

    // No policy governs the invoice: Neka is for someone who keeps the books.
    await getPool().query(`UPDATE public.company_attest_policies SET enabled = false WHERE company_id = $1`, [w.companyId])
    const unrestricted = await registeredInvoice(w, 1000)
    const readOnly = await rejectInApp(w, w.veraId, unrestricted)
    expect(readOnly.status).toBe(403)
    expect(await json(readOnly)).toMatchObject({ error: { code: 'FORBIDDEN', details: { reason: 'read_only' } } })
    expect(await trail(unrestricted)).toEqual([])
  })
})

describe('two steps: two different attesters from the amount, at least one with a covering limit', () => {
  it('controller first, CEO second through the mail; the same person twice and two without a covering limit are refused', async () => {
    const w = await seedWorld()
    await policy(w, { annaLimit: 50000, twoStep: 50000, attesters: [w.annaId, w.boId, w.ownerId] })
    // The owner attests up to 60 000 kr as well.
    await getPool().query(
      `INSERT INTO public.company_attest_limits (company_id, user_id, scope, max_amount_sek, updated_by) VALUES ($1, $2, 'supplier_invoice', 60000, $2)`,
      [w.companyId, w.ownerId],
    )
    const invoiceId = await registeredInvoice(w, 80000)

    const first = await approveInApp(w, w.annaId, invoiceId)
    expect(first.status, JSON.stringify(await json(first.clone()))).toBe(200)
    expect(await json(first)).toMatchObject({
      data: { status: 'registered', attest: { approved: false, steps: 2, approvals_needed: 1, needs_covering: true, remaining: [w.boId] } },
    })
    expect(await marker(invoiceId)).toMatchObject({ approved_at: null })
    expect(await blocked(w, invoiceId)).toBe(true)

    const again = await approveInApp(w, w.annaId, invoiceId)
    expect(again.status).toBe(409)
    expect(await json(again)).toMatchObject({ error: { code: 'ATTEST_ALREADY_GIVEN' } })

    // The owner's 60 000 kr does not cover 80 000 kr either: two without a covering limit do not make it.
    const short = await approveInApp(w, w.ownerId, invoiceId)
    expect(short.status).toBe(403)
    expect(await json(short)).toMatchObject({ error: { code: 'ATTEST_LIMIT_EXCEEDED' } })

    const second = await approveByLink(w, w.boId, invoiceId)
    expect(second.status, JSON.stringify(await json(second.clone()))).toBe(200)
    expect(await json(second)).toMatchObject({ data: { decision: 'approved', attested: true } })
    expect(await marker(invoiceId)).toMatchObject({ status: 'approved', approved_by: w.boId })
    expect(await blocked(w, invoiceId)).toBe(false)
    expect(await trail(invoiceId)).toEqual([
      { user_id: w.annaId, decision: 'approved', source: 'app', step: 1, limit_sek: '50000.00', amount_sek: '80000.00' },
      { user_id: w.boId, decision: 'approved', source: 'email_link', step: 2, limit_sek: null, amount_sek: '80000.00' },
    ])
  })

  it('no fixed order: the CEO first, then the controller completes it; below the amount one is enough', async () => {
    const w = await seedWorld()
    await policy(w, { annaLimit: 50000, twoStep: 50000 })
    const invoiceId = await registeredInvoice(w, 80000)
    expect((await approveInApp(w, w.boId, invoiceId)).status).toBe(200)
    expect(await marker(invoiceId)).toMatchObject({ approved_at: null })
    expect((await approveInApp(w, w.annaId, invoiceId)).status).toBe(200)
    expect(await marker(invoiceId)).toMatchObject({ status: 'approved', approved_by: w.annaId })

    const below = await registeredInvoice(w, 49999.99)
    expect((await approveInApp(w, w.annaId, below)).status).toBe(200)
    expect(await marker(below)).toMatchObject({ status: 'approved', approved_by: w.annaId })
  })
})

describe('concurrent attests take turns on the invoice', () => {
  /** A service-role transaction on its own connection, held open until the caller ends it. */
  async function serviceTx(): Promise<PoolClient & { pid: number }> {
    const client = await getClient()
    await client.query('BEGIN')
    await client.query(`SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true)`)
    await client.query(`SELECT set_config('request.jwt.claim.role', 'service_role', true)`)
    await client.query('SET LOCAL ROLE service_role')
    const { rows } = await client.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)
    return Object.assign(client, { pid: rows[0]!.pid })
  }

  async function waitsForLock(pid: number): Promise<void> {
    for (let i = 0; i < 250; i++) {
      const { rows } = await getPool().query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'`,
        [pid],
      )
      if (rows[0]!.n > 0) return
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error(`backend ${pid} never waited for the invoice lock`)
  }

  const ATTEST = `SELECT public.attest_supplier_invoice($1, $2, $3, 'api') AS r`

  it('all: two attesters at once, the second waits and completes the policy, and the marker is set once', async () => {
    const w = await seedWorld()
    await policy(w, { mode: 'all' })
    const invoiceId = await registeredInvoice(w, 10000)
    const a = await serviceTx()
    const b = await serviceTx()
    try {
      const first = await a.query<{ r: Record<string, unknown> }>(ATTEST, [w.companyId, invoiceId, w.annaId])
      expect(first.rows[0]!.r).toMatchObject({ ok: true, approved: false })
      const pending = b.query<{ r: Record<string, unknown> }>(ATTEST, [w.companyId, invoiceId, w.boId])
      await waitsForLock(b.pid)
      await a.query('COMMIT')
      const second = await pending
      await b.query('COMMIT')
      // Without the lock both would have read a round without the other, and nobody would have set the marker.
      expect(second.rows[0]!.r).toMatchObject({ ok: true, approved: true, step: 2 })
    } finally {
      for (const c of [a, b]) {
        await c.query('ROLLBACK').catch(() => {})
        c.release()
      }
    }
    expect(await marker(invoiceId)).toMatchObject({ status: 'approved', approved_by: w.boId })
    expect((await trail(invoiceId)).map((t) => [t.user_id, t.step])).toEqual([
      [w.annaId, 1],
      [w.boId, 2],
    ])
  })

  it('any: two attesters at once, one attests and the other finds it attested, with one row in the trail', async () => {
    const w = await seedWorld()
    await policy(w)
    const invoiceId = await registeredInvoice(w, 10000)
    const a = await serviceTx()
    const b = await serviceTx()
    try {
      expect((await a.query<{ r: Record<string, unknown> }>(ATTEST, [w.companyId, invoiceId, w.annaId])).rows[0]!.r).toMatchObject({ ok: true, approved: true })
      const pending = b.query<{ r: Record<string, unknown> }>(ATTEST, [w.companyId, invoiceId, w.boId])
      await waitsForLock(b.pid)
      await a.query('COMMIT')
      expect((await pending).rows[0]!.r).toMatchObject({ ok: false, code: 'SI_APPROVE_NOT_REGISTERED', current_status: 'approved' })
      await b.query('COMMIT')
    } finally {
      for (const c of [a, b]) {
        await c.query('ROLLBACK').catch(() => {})
        c.release()
      }
    }
    expect(await marker(invoiceId)).toMatchObject({ approved_by: w.annaId })
    expect((await trail(invoiceId)).map((t) => t.user_id)).toEqual([w.annaId])
  })
})

describe('every door, and the key capped by the lower of the limit and its ceiling', () => {
  async function apiKey(w: World, userId: string, ceiling: number | null): Promise<string> {
    const key = generateApiKey('live')
    await getPool().query(
      `INSERT INTO public.api_keys (user_id, company_id, key_hash, key_prefix, name, scopes, unattended_commit_limit)
       VALUES ($1, $2, $3, $4, 'Attestnyckel', $5, $6)`,
      [userId, w.companyId, key.hash, key.prefix, ['suppliers:read', 'suppliers:write'], ceiling],
    )
    return key.key
  }

  async function approveByV1(w: World, key: string, invoiceId: string): Promise<Response> {
    return v1ApproveRoute(
      new Request(`http://localhost/api/v1/companies/${w.companyId}/supplier-invoices/${invoiceId}/approve`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Idempotency-Key': `attest-levels-${randomUUID()}` },
      }),
      params({ companyId: w.companyId, id: invoiceId }),
    )
  }

  it("v1: a key attests nothing above the lower of the person's limit and its ceiling; within both it attests", async () => {
    const w = await seedWorld()
    // Anna attests up to 20 000 kr; from 25 000 kr two attesters, so in the app she may give the first of two.
    await policy(w, { annaLimit: 20000, twoStep: 25000 })
    const lowKey = await apiKey(w, w.annaId, 10000)
    const highKey = await apiKey(w, w.annaId, 50000)

    // The key's ceiling is the lower: refused before the rules, as every v1 door that attests (#125).
    const overCeiling = await registeredInvoice(w, 15000)
    const byLowKey = await approveByV1(w, lowKey, overCeiling)
    expect(byLowKey.status).toBe(403)
    expect(await json(byLowKey)).toMatchObject({ error: { code: 'UNATTENDED_COMMIT_LIMIT_EXCEEDED', details: { attempted: 15000, limit: 10000 } } })
    expect(await trail(overCeiling)).toEqual([])
    // In the app the same person attests it: 15 000 kr is within her own limit.
    expect((await approveInApp(w, w.annaId, overCeiling)).status).toBe(200)

    // The person's limit is the lower: through the key she gives no step above it, not even the first of two.
    const overLimit = await registeredInvoice(w, 30000)
    const byHighKey = await approveByV1(w, highKey, overLimit)
    expect(byHighKey.status).toBe(403)
    expect(await json(byHighKey)).toMatchObject({ error: { code: 'ATTEST_LIMIT_EXCEEDED', details: { reason: 'key_limit', limit_sek: 20000, amount_sek: 30000 } } })
    expect(await trail(overLimit)).toEqual([])
    const inApp = await approveInApp(w, w.annaId, overLimit)
    expect(inApp.status, JSON.stringify(await json(inApp.clone()))).toBe(200)
    expect(await json(inApp)).toMatchObject({ data: { attest: { approved: false, steps: 2 } } })

    const within = await registeredInvoice(w, 8000)
    const ok = await approveByV1(w, lowKey, within)
    expect(ok.status, JSON.stringify(await json(ok.clone()))).toBe(200)
    expect(await trail(within)).toEqual([{ user_id: w.annaId, decision: 'approved', source: 'api', step: 1, limit_sek: '10000.00', amount_sek: '8000.00' }])
  })

  it("MCP: the agent's attest over the person's limit waits for a person, who attests it", async () => {
    const w = await seedWorld()
    await policy(w, { annaLimit: 20000 })
    const invoiceId = await registeredInvoice(w, 30000)
    const apiKeyId = randomUUID()
    // The key has no ceiling of its own: the person's limit is the lower one.
    await getPool().query(
      `INSERT INTO public.api_keys (id, user_id, company_id, key_hash, key_prefix, name, scopes, unattended_commit_limit)
       VALUES ($1, $2, $3, $4, 'gnubok_sk_test', 'Claude', NULL, NULL)`,
      [apiKeyId, w.annaId, w.companyId, randomUUID().replaceAll('-', '')],
    )
    const actor: ActorContext = { type: 'api_key', id: apiKeyId, label: 'Claude', unattendedCommitLimit: null, oauthKey: false, serviceAccountId: null }
    const tool = tools.find((t) => t.name === 'gnubok_approve_supplier_invoice')!
    const staged = (await tool.execute({ supplier_invoice_id: invoiceId }, w.companyId, w.annaId, createServiceClientNoCookies(), actor)) as Record<string, unknown>
    expect(staged).toMatchObject({ staged: true, operation_id: expect.any(String) })
    const pendingOperation = async () => {
      const { rows } = await getPool().query(`SELECT * FROM public.pending_operations WHERE id = $1`, [staged.operation_id])
      return rows[0] as PendingOperation
    }

    const byAgent = await commitPendingOperation(createServiceClientNoCookies(), w.annaId, w.companyId, await pendingOperation(), {
      commitMethod: 'api_key',
      actor: { type: 'api_key', label: 'Claude', unattendedCommitLimit: null },
    })
    expect(byAgent).toMatchObject({ status: 'failed', code: 'UNATTENDED_COMMIT_LIMIT_EXCEEDED', unattended_limit: { attempted: 30000, limit: 20000 } })
    expect((await pendingOperation()).status).toBe('pending')
    expect(await trail(invoiceId)).toEqual([])

    // The CEO approves it in /pending: his attest, without a limit.
    const byCeo = await commitPendingOperation(createServiceClientNoCookies(), w.boId, w.companyId, await pendingOperation(), {
      commitMethod: 'user_accept',
      actor: { type: 'user', label: 'ceo@example.se' },
    })
    expect(byCeo, JSON.stringify(byCeo)).toMatchObject({ status: 'committed' })
    expect(await marker(invoiceId)).toMatchObject({ status: 'approved', approved_by: w.boId })
    expect(await trail(invoiceId)).toEqual([{ user_id: w.boId, decision: 'approved', source: 'mcp', step: 1, limit_sek: null, amount_sek: '30000.00' }])
  })

  it('a session attests only as itself and only from the app; anon cannot attest at all', async () => {
    const w = await seedWorld()
    await policy(w)
    const invoiceId = await registeredInvoice(w, 1000)
    const { error } = await memberClient(w.cillaId).rpc('attest_supplier_invoice', {
      p_company_id: w.companyId,
      p_invoice_id: invoiceId,
      p_user_id: w.annaId,
    })
    expect(error).toMatchObject({ code: '42501' })
    expect(await trail(invoiceId)).toEqual([])

    // Anna's own call records 'app', whatever source or key she names.
    const { data } = await memberClient(w.annaId).rpc('attest_supplier_invoice', {
      p_company_id: w.companyId,
      p_invoice_id: invoiceId,
      p_source: 'email_link',
      p_via_key: true,
      p_key_ceiling: 1,
    })
    expect(data).toMatchObject({ ok: true, approved: true })
    expect(await trail(invoiceId)).toMatchObject([{ user_id: w.annaId, source: 'app' }])

    const { rows } = await getPool().query<{ anon: boolean; authenticated: boolean; ruling: boolean }>(
      `SELECT has_function_privilege('anon', 'public.attest_supplier_invoice(uuid, uuid, uuid, text, boolean, numeric)', 'EXECUTE') AS anon,
              has_function_privilege('authenticated', 'public.attest_supplier_invoice(uuid, uuid, uuid, text, boolean, numeric)', 'EXECUTE') AS authenticated,
              has_function_privilege('authenticated', 'public.supplier_invoice_attest_ruling(uuid, uuid, uuid, boolean, numeric)', 'EXECUTE') AS ruling`,
    )
    expect(rows[0]).toEqual({ anon: false, authenticated: true, ruling: false })
  })
})

describe('the policy and its limits are saved together', () => {
  it('an owner saves both through Inställningar > Attest, each limit is logged as the owner, and a member cannot', async () => {
    const w = await seedWorld()
    session.userId = w.ownerId
    session.companyId = w.companyId
    const response = await savePolicyRoute(
      new Request('http://localhost/api/supplier-invoices/attest-policy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: true,
          threshold_amount: null,
          mode: 'any',
          attesters: [w.annaId, w.boId],
          preparer_may_attest: false,
          two_step_from_sek: 50000,
          limits: [
            { user_id: w.annaId, max_amount_sek: 50000 },
            { user_id: w.boId, max_amount_sek: null },
          ],
        }),
      }),
      params({}),
    )
    expect(response.status, JSON.stringify(await json(response.clone()))).toBe(200)
    expect(await json(response)).toMatchObject({
      data: { policy: { enabled: true, two_step_from_sek: 50000 }, limits: { [w.annaId]: 50000, [w.boId]: null } },
    })
    const { rows: logged } = await getPool().query<{ action: string; user_id: string; record: string }>(
      `SELECT a.action, a.user_id::text, a.new_state->>'user_id' AS record
         FROM public.audit_log a WHERE a.company_id = $1 AND a.table_name = 'company_attest_limits' ORDER BY a.new_state->>'user_id'`,
      [w.companyId],
    )
    expect(logged).toEqual(
      [
        { action: 'INSERT', user_id: w.ownerId, record: w.annaId },
        { action: 'INSERT', user_id: w.ownerId, record: w.boId },
      ].sort((a, b) => a.record.localeCompare(b.record)),
    )

    // A member's own call meets the admin-only RLS policies, and nothing changes.
    await expect(
      withUserContext(w.cillaId, (client) =>
        client.query(`SELECT public.save_company_attest_policy($1, false, NULL, 'any', '{}'::uuid[], false, NULL, '[]'::jsonb, $2)`, [w.companyId, w.cillaId]),
      ),
    ).rejects.toMatchObject({ code: '42501' })
    const { rows: kept } = await getPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM public.company_attest_limits WHERE company_id = $1`, [w.companyId])
    expect(kept[0]!.n).toBe(2)

    // Dropping Anna drops her limit, logged as the admin who did it.
    await withUserContext(w.ownerId, async (client) => {
      await client.query(`SELECT public.save_company_attest_policy($1, true, NULL, 'any', $2::uuid[], false, NULL, $3::jsonb, $4)`, [
        w.companyId,
        [w.boId],
        JSON.stringify([{ user_id: w.boId, max_amount_sek: null }]),
        w.ownerId,
      ])
      const { rows } = await client.query<{ action: string; user_id: string }>(
        `SELECT action, user_id::text FROM public.audit_log WHERE company_id = $1 AND table_name = 'company_attest_limits' AND action = 'DELETE'`,
        [w.companyId],
      )
      expect(rows).toEqual([{ action: 'DELETE', user_id: w.ownerId }])

      // A save that leaves the limits as they are still drops a former attester's.
      await client.query(`SELECT public.save_company_attest_policy($1, true, NULL, 'any', $2::uuid[], false, NULL, NULL, $3)`, [
        w.companyId,
        [w.annaId],
        w.ownerId,
      ])
      const { rows: left } = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.company_attest_limits WHERE company_id = $1`, [w.companyId])
      expect(left[0]!.n).toBe(0)
    })
  })

  it('refuses two steps with one attester, a limit of zero and an unknown scope', async () => {
    const w = await seedWorld()
    await expect(
      getPool().query(
        `INSERT INTO public.company_attest_policies (company_id, enabled, mode, attesters, two_step_from_sek, updated_by) VALUES ($1, true, 'any', $2::uuid[], 1000, $3)`,
        [w.companyId, [w.annaId], w.ownerId],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'company_attest_policies_two_step_needs_two' })
    await expect(
      getPool().query(`INSERT INTO public.company_attest_limits (company_id, user_id, max_amount_sek, updated_by) VALUES ($1, $2, 0, $3)`, [w.companyId, w.annaId, w.ownerId]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'company_attest_limits_max_amount_check' })
    await expect(
      getPool().query(`INSERT INTO public.company_attest_limits (company_id, user_id, scope, updated_by) VALUES ($1, $2, 'payments', $3)`, [w.companyId, w.annaId, w.ownerId]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'company_attest_limits_scope_check' })
  })
})
