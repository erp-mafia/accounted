/**
 * Ordered attest steps and substitutes (#192, migration 20261108180000):
 * förattest per project first, then the attest, and a substitute attesting
 * in an attester's place, applied by the database when an approval is
 * recorded (attest_supplier_invoice, supplier_invoice_attest_ruling).
 *
 *   1. opt-in: for a company that names no förattestant, no project
 *      attester and no substitute, the new ruling answers exactly what the
 *      ruling of 20261102202100 answered, case by case (that function is
 *      read from its migration file and run beside the new one);
 *   2. the SQL rules and the TypeScript rules (attest-policy.ts) agree, case
 *      by case, with förattest groups, projects on lines, substitutes that
 *      run, ended or have not started, and trails with steps and substitutes;
 *   3. through the doors: the project leader förattests in the app, ekonomi
 *      is refused until then and attests after, payment holds the invoice
 *      until the attest, and the attesters are queued for the mail;
 *   4. a substitute named in Inställningar > Attest attests through the
 *      mail as the attester, with the attester's limit, recorded "B för A";
 *      a member names only their own substitute, and every change is logged;
 *   5. the förattest is saved with the policy, a project must be one of the
 *      company's, and a save that does not touch it keeps it.
 *
 * What is not real: the HTTP hop to PostgREST, replaced by
 * tests/pg/postgrest-over-pg.ts as in supplier-invoice-attest-levels.pg.test.ts.
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { PoolClient } from 'pg'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { addDaysIso, todayIsoStockholm } from '@/lib/dates/iso'
import { mintAttestLink } from '@/lib/supplier-invoices/attest-links'
import { deciderRefusal } from '@/lib/supplier-invoices/attest-service'
import { loadAttestBlockedInvoiceIds, loadAttestPolicy } from '@/lib/supplier-invoices/attest-policy-read'
import {
  invoiceProjects,
  preAttestGroups,
  ruleOnApproval,
  type AttestationRecord,
  type AttestPolicy,
  type AttestSubstitution,
} from '@/lib/supplier-invoices/attest-policy'
import { POST as approveRoute } from '@/app/api/supplier-invoices/[id]/approve/route'
import { PUT as savePolicyRoute } from '@/app/api/supplier-invoices/attest-policy/route'
import { POST as addSubstituteRoute } from '@/app/api/supplier-invoices/attest-policy/substitutes/route'
import { DELETE as removeSubstituteRoute } from '@/app/api/supplier-invoices/attest-policy/substitutes/[id]/route'
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

/** A supabase-js client acting as a signed-in member, through RLS. */
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
 * A construction company under faktureringsmetoden: the owner, Eva and
 * Ville of ekonomi, Petra and Pål who lead projects P100 and P200, Bosse
 * who stands in, Cilla who registers, and Vera, a viewer.
 */
interface World {
  ownerId: string
  evaId: string
  villeId: string
  petraId: string
  palId: string
  bosseId: string
  cillaId: string
  veraId: string
  companyId: string
  supplierId: string
}

async function seedWorld(): Promise<World> {
  const { userId: ownerId, companyId } = await seedCompany()
  const ids: string[] = []
  for (let i = 0; i < 7; i++) ids.push(await insertAuthUser())
  const [evaId, villeId, petraId, palId, bosseId, cillaId, veraId] = ids as [string, string, string, string, string, string, string]
  for (const userId of [evaId, villeId, petraId, palId, bosseId, cillaId]) await insertCompanyMember({ companyId, userId, role: 'member' })
  await insertCompanyMember({ companyId, userId: veraId, role: 'viewer' })
  for (const id of [ownerId, ...ids]) await setActiveCompany(id, companyId)
  await getPool().query(
    `INSERT INTO public.company_settings (company_id, entity_type, vat_registered, accounting_method)
     VALUES ($1, 'aktiebolag', true, 'accrual')
     ON CONFLICT (company_id) DO UPDATE SET accounting_method = EXCLUDED.accounting_method`,
    [companyId],
  )
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.suppliers (user_id, company_id, name) VALUES ($1, $2, 'Byggvaror AB') RETURNING id::text`,
    [ownerId, companyId],
  )
  // The projects (dimension 6, seeded with the company where the trigger does it).
  await getPool().query(
    `INSERT INTO public.dimensions (company_id, sie_dim_no, name, is_system) VALUES ($1, 6, 'Projekt', true) ON CONFLICT (company_id, sie_dim_no) DO NOTHING`,
    [companyId],
  )
  await getPool().query(
    `INSERT INTO public.dimension_values (company_id, dimension_id, code, name)
     SELECT $1, d.id, v.code, v.name FROM public.dimensions d, (VALUES ('P100', 'Kv. Eken'), ('P200', 'Kv. Linden')) AS v(code, name)
      WHERE d.company_id = $1 AND d.sie_dim_no = 6`,
    [companyId],
  )
  return { ownerId, evaId, villeId, petraId, palId, bosseId, cillaId, veraId, companyId, supplierId: rows[0]!.id }
}

const INSERT_INVOICE = `INSERT INTO public.supplier_invoices
   (id, user_id, company_id, supplier_id, arrival_number, supplier_invoice_number, invoice_date, due_date,
    subtotal, vat_amount, total, remaining_amount, currency, total_sek, exchange_rate, default_dimensions)
 VALUES ($1, $2, $3, $4, floor(random() * 1000000)::int, $5, '2026-10-01', '2099-12-31', $6, $7, $8, $8, 'SEK', NULL, NULL, $9::jsonb)`

const INSERT_ITEM = `INSERT INTO public.supplier_invoice_items
   (supplier_invoice_id, description, quantity, unit_price, line_total, account_number, vat_rate, vat_amount, dimensions)
 VALUES ($1, 'Material', 1, $2, $2, '4010', 0.25, 0, $3::jsonb)`

/** An unattested invoice Cilla registered: its own project (or none) and lines with theirs. */
async function registeredInvoice(
  w: World,
  total: number,
  dims: { own?: string | null; lines?: Array<string | null> } = {},
  db: Pick<PoolClient, 'query'> = getPool(),
): Promise<string> {
  const id = randomUUID()
  await db.query(INSERT_INVOICE, [id, w.cillaId, w.companyId, w.supplierId, `F-${id.slice(0, 8)}`, total * 0.8, total * 0.2, total, JSON.stringify(dims.own ? { '6': dims.own } : {})])
  for (const project of dims.lines ?? []) {
    await db.query(INSERT_ITEM, [id, total * 0.8, JSON.stringify(project ? { '6': project } : {})])
  }
  return id
}

/** The issue's policy: Eva and Ville attest, Petra förattests P100 and Pål P200. */
async function policy(w: World, options: { pre?: string[]; projects?: Record<string, string[]>; mode?: 'any' | 'all'; attesters?: string[] } = {}): Promise<void> {
  await getPool().query(
    `INSERT INTO public.company_attest_policies (company_id, enabled, threshold_amount, mode, attesters, preparer_may_attest, two_step_from_sek, updated_by, pre_attesters, project_attesters)
     VALUES ($1, true, NULL, $2, $3::uuid[], false, NULL, $4, $5::uuid[], $6::jsonb)`,
    [
      w.companyId,
      options.mode ?? 'any',
      options.attesters ?? [w.evaId, w.villeId],
      w.ownerId,
      options.pre ?? [],
      JSON.stringify(options.projects ?? { P100: [w.petraId], P200: [w.palId] }),
    ],
  )
}

interface MarkerRow {
  status: string
  approved_at: Date | null
  approved_by: string | null
}

async function marker(invoiceId: string): Promise<MarkerRow> {
  const { rows } = await getPool().query<MarkerRow>(`SELECT status, approved_at, approved_by::text FROM public.supplier_invoices WHERE id = $1`, [invoiceId])
  return rows[0]!
}

interface TrailRow {
  user_id: string
  decision: string
  source: string
  step: number | null
  stage: string | null
  on_behalf_of: string | null
  limit_sek: string | null
}

async function trail(invoiceId: string): Promise<TrailRow[]> {
  const { rows } = await getPool().query<TrailRow>(
    `SELECT user_id::text, decision, source, step, stage, on_behalf_of::text, limit_sek::text
       FROM public.supplier_invoice_attestations WHERE supplier_invoice_id = $1 ORDER BY decided_at`,
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

async function approveInApp(w: World, userId: string, invoiceId: string): Promise<Response> {
  session.userId = userId
  session.companyId = w.companyId
  return approveRoute(new Request(`http://localhost/api/supplier-invoices/${invoiceId}/approve`, { method: 'POST' }), params({ id: invoiceId }))
}

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

/** The ruling of 20261102202100, read from its migration and created beside the new one as pg_temp.attest_ruling_before_192. */
function rulingBefore192(): string {
  const file = readFileSync(path.resolve(__dirname, '../../supabase/migrations/20261102202100_supplier_invoice_attest_viewer_attester.sql'), 'utf8')
  const start = file.indexOf('CREATE OR REPLACE FUNCTION public.supplier_invoice_attest_ruling(')
  const end = file.indexOf('$$;', file.indexOf('AS $$', start)) + 3
  expect(start).toBeGreaterThan(0)
  return file.slice(start, end).replace('CREATE OR REPLACE FUNCTION public.supplier_invoice_attest_ruling(', 'CREATE FUNCTION pg_temp.attest_ruling_before_192(')
}

describe('opt-in: a company that names none of it is ruled exactly as before', () => {
  it('answers what the ruling of 20261102202100 answered, case by case, but for the step it now names', async () => {
    const w = await seedWorld()
    const departed = await insertAuthUser()
    const people = [w.ownerId, w.evaId, w.villeId, w.petraId, w.cillaId, w.veraId, departed]
    const random = sequence(1192)
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)]!
    const mismatches: unknown[] = []
    const outcomes = new Set<string>()
    const client = await getClient()
    try {
      for (let i = 0; i < 160; i++) {
        await client.query('BEGIN')
        await client.query(rulingBefore192())
        await client.query(`UPDATE public.company_settings SET accounting_method = $2 WHERE company_id = $1`, [w.companyId, pick(['accrual', 'accrual', 'cash'])])
        const attesters = people.filter(() => random() < 0.55)
        const enabled = attesters.length > 0 && random() < 0.9
        await client.query(
          `INSERT INTO public.company_attest_policies (company_id, enabled, threshold_amount, mode, attesters, preparer_may_attest, two_step_from_sek, updated_by)
           VALUES ($1, $2, $3, $4, $5::uuid[], $6, $7, $8)`,
          [
            w.companyId,
            enabled,
            pick([null, null, 1000, 50000]),
            pick(['any', 'any', 'all']),
            attesters,
            random() < 0.3,
            enabled && attesters.length >= 2 && random() < 0.5 ? pick([0, 20000, 80000]) : null,
            w.ownerId,
          ],
        )
        for (const person of people) {
          if (random() < 0.5) continue
          await client.query(
            `INSERT INTO public.company_attest_limits (company_id, user_id, scope, max_amount_sek, updated_by) VALUES ($1, $2, 'supplier_invoice', $3, $4)`,
            [w.companyId, person, pick([null, 1, 10000, 60000, 100000]), w.ownerId],
          )
        }
        // Invoices carry projects all the same: with nobody named for one, they change nothing.
        const invoiceId = await registeredInvoice(w, pick([500, 10000, 60000, 80000, 120000]), { own: pick([null, 'P100']), lines: pick([[], ['P200'], [null, 'P100']]) }, client)
        await client.query(`UPDATE public.supplier_invoices SET user_id = $2 WHERE id = $1`, [invoiceId, pick([w.ownerId, w.evaId, w.villeId, w.cillaId])])
        for (let k = Math.floor(random() * 4); k > 0; k--) {
          // New rows name their step 'final'; rows from before have none.
          await client.query(
            `INSERT INTO public.supplier_invoice_attestations (company_id, supplier_invoice_id, user_id, decision, source, decided_at, stage)
             VALUES ($1, $2, $3, $4, 'app', $5, $6)`,
            [w.companyId, invoiceId, pick(people), random() < 0.8 ? 'approved' : 'rejected', new Date(Date.UTC(2026, 9, 1, 9, 10 - k)).toISOString(), pick([null, 'final'])],
          )
        }
        for (const actor of people) {
          for (const viaKey of [false, true]) {
            const keyCeiling = viaKey ? pick([null, 30000, 70000]) : null
            const { rows } = await client.query<{ before: Record<string, unknown>; after: Record<string, unknown> }>(
              `SELECT pg_temp.attest_ruling_before_192($1, $2, $3, $4, $5) AS before,
                      public.supplier_invoice_attest_ruling($1, $2, $3, $4, $5) AS after`,
              [w.companyId, invoiceId, actor, viaKey, keyCeiling],
            )
            const { before, after } = rows[0]!
            const { stage, on_behalf_of: onBehalfOf, ...rest } = after
            outcomes.add([before.kind, before.code, before.reason].filter(Boolean).join('/'))
            const expectedStage = after.kind === 'record' ? 'final' : undefined
            if (JSON.stringify(rest) !== JSON.stringify(before) || stage !== expectedStage || (onBehalfOf ?? null) !== null) {
              mismatches.push({ case: i, actor, viaKey, keyCeiling, before, after })
            }
          }
        }
        await client.query('ROLLBACK')
      }
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
    expect(mismatches.slice(0, 5)).toEqual([])
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
  }, 120_000)
})

describe('the SQL rules and the TypeScript rules agree', () => {
  it('rule alike with förattest, projects on lines, substitutes and trails with steps', async () => {
    const w = await seedWorld()
    const departed = await insertAuthUser()
    const people = [w.ownerId, w.evaId, w.villeId, w.petraId, w.palId, w.bosseId, w.cillaId, w.veraId, departed]
    const writers = new Set([w.ownerId, w.evaId, w.villeId, w.petraId, w.palId, w.bosseId, w.cillaId])
    const members = { attesters: new Set([...writers, w.veraId]), writers }
    const today = todayIsoStockholm()
    const random = sequence(192)
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)]!
    const some = (xs: readonly string[], p: number) => xs.filter(() => random() < p)
    const mismatches: unknown[] = []
    const outcomes = new Set<string>()
    const client = await getClient()
    try {
      for (let i = 0; i < 260; i++) {
        await client.query('BEGIN')
        const attesters = some(people, 0.5)
        const enabled = attesters.length > 0 && random() < 0.92
        const projectAttesters: Record<string, string[]> = {}
        for (const code of ['P100', 'P200']) {
          const ids = some(people, 0.3)
          if (ids.length > 0 && random() < 0.75) projectAttesters[code] = ids
        }
        const p: AttestPolicy = {
          enabled,
          threshold_amount: pick([null, null, 1000]),
          mode: pick(['any', 'any', 'all'] as const),
          attesters,
          preparer_may_attest: random() < 0.25,
          two_step_from_sek: enabled && attesters.length >= 2 && random() < 0.4 ? pick([0, 50000]) : null,
          pre_attesters: random() < 0.5 ? some(people, 0.3) : [],
          project_attesters: projectAttesters,
          updated_by: null,
          updated_at: null,
        }
        await client.query(
          `INSERT INTO public.company_attest_policies
             (company_id, enabled, threshold_amount, mode, attesters, preparer_may_attest, two_step_from_sek, updated_by, pre_attesters, project_attesters)
           VALUES ($1, $2, $3, $4, $5::uuid[], $6, $7, $8, $9::uuid[], $10::jsonb)`,
          [w.companyId, p.enabled, p.threshold_amount, p.mode, p.attesters, p.preparer_may_attest, p.two_step_from_sek, w.ownerId, p.pre_attesters, JSON.stringify(projectAttesters)],
        )
        const limits = new Map<string, number | null>()
        for (const person of people) {
          if (random() < 0.6) continue
          const limit = pick([null, 1000, 60000])
          limits.set(person, limit)
          await client.query(
            `INSERT INTO public.company_attest_limits (company_id, user_id, scope, max_amount_sek, updated_by) VALUES ($1, $2, 'supplier_invoice', $3, $4)`,
            [w.companyId, person, limit, w.ownerId],
          )
        }
        // Substitutes: running today, ended, or not started yet.
        const running: AttestSubstitution[] = []
        for (let k = Math.floor(random() * 3); k > 0; k--) {
          const principal = pick(people.slice(0, 8))
          const substitute = pick(people.filter((id) => id !== principal))
          const when = pick(['now', 'now', 'past', 'future'] as const)
          const [from, to] = when === 'now' ? [addDaysIso(today, -1), today] : when === 'past' ? [addDaysIso(today, -9), addDaysIso(today, -1)] : [addDaysIso(today, 1), addDaysIso(today, 5)]
          await client.query(
            `INSERT INTO public.company_attest_substitutes (company_id, user_id, substitute_user_id, starts_on, ends_on, created_by) VALUES ($1, $2, $3, $4, $5, $6)`,
            [w.companyId, principal, substitute, from, to, w.ownerId],
          )
          if (when === 'now') running.push({ user_id: principal, substitute_user_id: substitute })
        }
        p.substitutes = running

        const own = pick([null, 'P100', 'P200', 'P900'])
        // '' on a line clears the invoice's project, as the verifikat books it.
        const lines = pick([[], ['P100'], [null], ['P200', null], ['P100', 'P200'], ['P900'], [''], ['', 'P200']])
        const total = pick([500, 10000, 60000])
        const invoiceId = randomUUID()
        const registrant = pick([w.ownerId, w.evaId, w.petraId, w.cillaId])
        await client.query(INSERT_INVOICE, [invoiceId, registrant, w.companyId, w.supplierId, `F-${invoiceId.slice(0, 8)}`, total * 0.8, total * 0.2, total, JSON.stringify(own ? { '6': own } : {})])
        const lineDims = (project: string | null) => (project === null ? {} : { '6': project })
        for (const project of lines) await client.query(INSERT_ITEM, [invoiceId, total * 0.8, JSON.stringify(lineDims(project))])
        const invoice = {
          user_id: registrant,
          is_credit_note: false,
          currency: 'SEK',
          total,
          total_sek: null,
          exchange_rate: null,
          projects: invoiceProjects(own ? { '6': own } : {}, lines.map((project) => ({ dimensions: lineDims(project) }))),
        }

        // The groups themselves agree.
        const { rows: groupRows } = await client.query<{ g: unknown }>(`SELECT public.supplier_invoice_pre_attest_groups($1, $2) AS g`, [w.companyId, invoiceId])
        const sqlGroups = (groupRows[0]!.g as Array<{ project: string | null; attesters: string[] }>).map((g) => ({ project: g.project, attesters: [...new Set(g.attesters)] }))
        const tsGroups = preAttestGroups(p, invoice)
        if (JSON.stringify(sqlGroups) !== JSON.stringify(tsGroups)) mismatches.push({ case: i, groups: { sql: sqlGroups, ts: tsGroups } })

        const decisions: AttestationRecord[] = []
        for (let k = Math.floor(random() * 4); k > 0; k--) {
          const sub = running.length > 0 && random() < 0.3 ? pick(running) : null
          const row: AttestationRecord = {
            user_id: sub ? sub.substitute_user_id : pick(people),
            decision: random() < 0.85 ? 'approved' : 'rejected',
            decided_at: new Date(Date.UTC(2026, 9, 1, 9, 10 - k)).toISOString(),
            stage: pick(['pre', 'final', null] as const),
            on_behalf_of: sub ? sub.user_id : null,
          }
          decisions.push(row)
          await client.query(
            `INSERT INTO public.supplier_invoice_attestations (company_id, supplier_invoice_id, user_id, decision, source, decided_at, stage, on_behalf_of)
             VALUES ($1, $2, $3, $4, 'app', $5, $6, $7)`,
            [w.companyId, invoiceId, row.user_id, row.decision, row.decided_at, row.decision === 'approved' ? row.stage : null, row.on_behalf_of],
          )
          if (row.decision === 'rejected') row.stage = null
        }

        for (const actor of people) {
          for (const viaKey of [false, true]) {
            const keyCeiling = viaKey ? pick([null, 30000]) : null
            const { rows } = await client.query<{ r: Record<string, unknown> }>(
              `SELECT public.supplier_invoice_attest_ruling($1, $2, $3, $4, $5) AS r`,
              [w.companyId, invoiceId, actor, viaKey, keyCeiling],
            )
            const sql = rows[0]!.r
            const gate = deciderRefusal(members, actor, false)
            const rule = gate ? null : ruleOnApproval(p, 'accrual', invoice, decisions, actor, p.enabled ? members.attesters : undefined, { limits, viaKey, keyCeiling })
            const readOnly = rule && rule.kind !== 'refused' ? deciderRefusal(members, actor, rule.kind === 'unrestricted') : null
            const ts: Record<string, unknown> =
              gate || readOnly ? { kind: 'refused', code: 'FORBIDDEN', reason: gate ?? readOnly } : (rule as unknown as Record<string, unknown>)
            const num = (v: unknown) => (v === null || v === undefined ? null : Number(v))
            const shape = (r: Record<string, unknown>, limitKey: string, stageKey: string, behalfKey: string) => ({
              kind: r.kind,
              code: r.code ?? null,
              reason: r.reason ?? null,
              satisfies: r.satisfies ?? null,
              step: num(r.step),
              limit: num(r.kind === 'record' ? r[limitKey] : r.limit_sek),
              stage: r.kind === 'record' ? (r[stageKey] ?? 'final') : null,
              onBehalfOf: r.kind === 'record' ? (r[behalfKey] ?? null) : null,
            })
            const a = shape(sql, 'limit_sek', 'stage', 'on_behalf_of')
            const b = shape(ts, 'limitSek', 'stage', 'onBehalfOf')
            outcomes.add([a.kind, a.code, a.reason, a.kind === 'record' ? a.stage : null, a.onBehalfOf ? 'for' : null].filter(Boolean).join('/'))
            if (JSON.stringify(a) !== JSON.stringify(b)) mismatches.push({ case: i, actor, viaKey, sql: a, ts: b })
          }
        }
        await client.query('ROLLBACK')
      }
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
    expect(mismatches.slice(0, 5)).toEqual([])
    // The cases reach the new outcomes, so agreement is not agreement on a few.
    for (const outcome of ['record/pre', 'record/final', 'record/pre/for', 'record/final/for', 'refused/ATTEST_NOT_ALLOWED/other_step', 'refused/ATTEST_ALREADY_GIVEN']) {
      expect([...outcomes]).toContain(outcome)
    }
  }, 120_000)
})

describe('through the doors: the project leader first, then ekonomi', () => {
  it('holds ekonomi until the förattest, records each step, and pays only once attested', async () => {
    const w = await seedWorld()
    await policy(w)
    const invoiceId = await registeredInvoice(w, 30000, { own: 'P100', lines: ['P100'] })

    const early = await approveInApp(w, w.evaId, invoiceId)
    expect(early.status).toBe(403)
    expect(await json(early)).toMatchObject({ error: { code: 'ATTEST_NOT_ALLOWED', details: { reason: 'other_step' } } })
    expect(await trail(invoiceId)).toEqual([])

    // Pål leads another project: not his to förattest.
    const stranger = await approveInApp(w, w.palId, invoiceId)
    expect(await json(stranger)).toMatchObject({ error: { code: 'ATTEST_NOT_ALLOWED', details: { reason: 'not_attester' } } })

    const pre = await approveInApp(w, w.petraId, invoiceId)
    expect(pre.status, JSON.stringify(await json(pre.clone()))).toBe(200)
    expect(await json(pre)).toMatchObject({ data: { status: 'registered', attest: { approved: false, stage: 'final', remaining: [w.evaId, w.villeId] } } })
    expect(await marker(invoiceId)).toMatchObject({ approved_at: null })
    expect(await blocked(w, invoiceId)).toBe(true)

    const fin = await approveByLink(w, w.evaId, invoiceId)
    expect(fin.status, JSON.stringify(await json(fin.clone()))).toBe(200)
    expect(await json(fin)).toMatchObject({ data: { decision: 'approved', attested: true } })
    expect(await marker(invoiceId)).toMatchObject({ status: 'approved', approved_by: w.evaId })
    expect(await blocked(w, invoiceId)).toBe(false)
    expect(await trail(invoiceId)).toEqual([
      { user_id: w.petraId, decision: 'approved', source: 'app', step: 1, stage: 'pre', on_behalf_of: null, limit_sek: null },
      { user_id: w.evaId, decision: 'approved', source: 'email_link', step: 2, stage: 'final', on_behalf_of: null, limit_sek: null },
    ])
  })

  it('asks each project its own förattest, and queues the attesters for the mail once the last is given', async () => {
    const w = await seedWorld()
    await policy(w)
    const invoiceId = await registeredInvoice(w, 30000, { lines: ['P100', 'P200'] })
    await getPool().query(
      `INSERT INTO public.supplier_invoice_attest_mail_state (supplier_invoice_id, company_id, queued_at, asked_at) VALUES ($1, $2, now() - interval '1 day', now() - interval '1 day')`,
      [invoiceId, w.companyId],
    )
    expect((await approveInApp(w, w.petraId, invoiceId)).status).toBe(200)
    const { rows: still } = await getPool().query<{ asked: boolean }>(`SELECT asked_at IS NOT NULL AS asked FROM public.supplier_invoice_attest_mail_state WHERE supplier_invoice_id = $1`, [invoiceId])
    expect(still[0]!.asked).toBe(true)
    expect(await json(await approveInApp(w, w.villeId, invoiceId))).toMatchObject({ error: { details: { reason: 'other_step' } } })

    expect((await approveInApp(w, w.palId, invoiceId)).status).toBe(200)
    // The förattest is complete: the attesters' round is queued, as for a new registration.
    const { rows: queued } = await getPool().query<{ asked: boolean; fresh: boolean }>(
      `SELECT asked_at IS NOT NULL AS asked, queued_at > now() - interval '1 minute' AS fresh FROM public.supplier_invoice_attest_mail_state WHERE supplier_invoice_id = $1`,
      [invoiceId],
    )
    expect(queued[0]).toEqual({ asked: false, fresh: true })
    expect((await approveInApp(w, w.villeId, invoiceId)).status).toBe(200)
    expect(await marker(invoiceId)).toMatchObject({ status: 'approved', approved_by: w.villeId })
  })

  it('never lets one person give both steps', async () => {
    const w = await seedWorld()
    // Eva leads P100 and attests: her förattest leaves the attest to Ville.
    await policy(w, { projects: { P100: [w.evaId] } })
    const invoiceId = await registeredInvoice(w, 30000, { own: 'P100' })
    expect((await approveInApp(w, w.evaId, invoiceId)).status).toBe(200)
    const again = await approveInApp(w, w.evaId, invoiceId)
    expect(again.status).toBe(409)
    expect(await json(again)).toMatchObject({ error: { code: 'ATTEST_ALREADY_GIVEN' } })
    expect((await approveInApp(w, w.villeId, invoiceId)).status).toBe(200)
    expect(await marker(invoiceId)).toMatchObject({ approved_by: w.villeId })
  })
})

describe('substitutes', () => {
  async function addSubstitute(w: World, actor: string, body: Record<string, string>): Promise<Response> {
    session.userId = actor
    session.companyId = w.companyId
    return addSubstituteRoute(
      new Request('http://localhost/api/supplier-invoices/attest-policy/substitutes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      params({}),
    )
  }

  it('lets the substitute attest through the mail as the attester, with their limit, recorded for them', async () => {
    const w = await seedWorld()
    await policy(w, { projects: {} })
    await getPool().query(
      `INSERT INTO public.company_attest_limits (company_id, user_id, scope, max_amount_sek, updated_by) VALUES ($1, $2, 'supplier_invoice', 50000, $3), ($1, $4, 'supplier_invoice', 1000, $3)`,
      [w.companyId, w.evaId, w.ownerId, w.bosseId],
    )
    const today = todayIsoStockholm()
    // Eva names Bosse for herself, as a member may.
    const added = await addSubstitute(w, w.evaId, { user_id: w.evaId, substitute_user_id: w.bosseId, starts_on: today, ends_on: addDaysIso(today, 7) })
    expect(added.status, JSON.stringify(await json(added.clone()))).toBe(200)
    expect(await json(added)).toMatchObject({ data: { substitutes: [{ user_id: w.evaId, substitute_user_id: w.bosseId, active: true }] } })

    // Bosse is no attester himself; as Eva's substitute he attests 30 000 kr under her limit.
    const invoiceId = await registeredInvoice(w, 30000)
    const byLink = await approveByLink(w, w.bosseId, invoiceId)
    expect(byLink.status, JSON.stringify(await json(byLink.clone()))).toBe(200)
    expect(await marker(invoiceId)).toMatchObject({ status: 'approved', approved_by: w.bosseId })
    expect(await trail(invoiceId)).toEqual([
      { user_id: w.bosseId, decision: 'approved', source: 'email_link', step: 1, stage: 'final', on_behalf_of: w.evaId, limit_sek: '50000.00' },
    ])
    // The policy's one read carries him while the period runs.
    expect((await loadAttestPolicy(createServiceClientNoCookies(), w.companyId)).substitutes).toEqual([{ user_id: w.evaId, substitute_user_id: w.bosseId }])
    expect((await loadAttestPolicy(createServiceClientNoCookies(), w.companyId, addDaysIso(today, 8))).substitutes).toBeUndefined()

    const { rows: logged } = await getPool().query<{ action: string; user_id: string }>(
      `SELECT action, user_id::text FROM public.audit_log WHERE company_id = $1 AND table_name = 'company_attest_substitutes'`,
      [w.companyId],
    )
    expect(logged).toEqual([{ action: 'INSERT', user_id: w.evaId }])
  })

  it('lets a member name only their own substitute; an owner names and removes anyone\'s, logged as the owner', async () => {
    const w = await seedWorld()
    await policy(w, { projects: {} })
    const today = todayIsoStockholm()
    const forSomeoneElse = await addSubstitute(w, w.villeId, { user_id: w.evaId, substitute_user_id: w.bosseId, starts_on: today, ends_on: today })
    expect(forSomeoneElse.status).toBe(403)
    // Nor straight at the table, past the service.
    await expect(
      withUserContext(w.villeId, (client) =>
        client.query(`SELECT public.add_company_attest_substitute($1, $2, $3, $4, $4, $5)`, [w.companyId, w.evaId, w.bosseId, today, w.villeId]),
      ),
    ).rejects.toMatchObject({ code: '42501' })

    const byOwner = await addSubstitute(w, w.ownerId, { user_id: w.evaId, substitute_user_id: w.bosseId, starts_on: today, ends_on: today })
    expect(byOwner.status, JSON.stringify(await json(byOwner.clone()))).toBe(200)
    const id = ((await json(byOwner)).data as { substitutes: Array<{ id: string }> }).substitutes[0]!.id

    // Ville cannot remove it, and a session cannot change one in place.
    session.userId = w.villeId
    expect((await removeSubstituteRoute(new Request(`http://localhost/x/${id}`, { method: 'DELETE' }), params({ id }))).status).toBe(403)
    const changed = await withUserContext(w.ownerId, (client) =>
      client.query(`UPDATE public.company_attest_substitutes SET ends_on = ends_on + 30 WHERE id = $1`, [id]).catch((error: { code?: string }) => error),
    )
    expect(changed).toMatchObject({ code: '42501' })

    session.userId = w.ownerId
    const removed = await removeSubstituteRoute(new Request(`http://localhost/x/${id}`, { method: 'DELETE' }), params({ id }))
    expect(removed.status, JSON.stringify(await json(removed.clone()))).toBe(200)
    const { rows: logged } = await getPool().query<{ action: string; user_id: string }>(
      `SELECT action, user_id::text FROM public.audit_log WHERE company_id = $1 AND table_name = 'company_attest_substitutes' ORDER BY created_at`,
      [w.companyId],
    )
    expect(logged).toEqual([
      { action: 'INSERT', user_id: w.ownerId },
      { action: 'DELETE', user_id: w.ownerId },
    ])

    // A period over a year, or that ends before it starts, never reaches the table.
    await expect(
      getPool().query(`INSERT INTO public.company_attest_substitutes (company_id, user_id, substitute_user_id, starts_on, ends_on) VALUES ($1, $2, $3, $4, $4::date + 400)`, [
        w.companyId,
        w.evaId,
        w.bosseId,
        today,
      ]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'company_attest_substitutes_period' })
  })
})

describe('the förattest is saved with the policy', () => {
  async function save(w: World, body: Record<string, unknown>): Promise<Response> {
    session.userId = w.ownerId
    session.companyId = w.companyId
    return savePolicyRoute(
      new Request('http://localhost/api/supplier-invoices/attest-policy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true, threshold_amount: null, mode: 'any', attesters: [w.evaId, w.villeId], preparer_may_attest: false, ...body }),
      }),
      params({}),
    )
  }

  it('saves the förattest, refuses a project the company does not have, and keeps it on a save that leaves it out', async () => {
    const w = await seedWorld()
    const unknown = await save(w, { project_attesters: [{ project: 'P999', attesters: [w.petraId] }] })
    expect(unknown.status).toBe(400)
    expect(await json(unknown)).toMatchObject({ error: { code: 'ATTEST_PROJECT_NOT_FOUND' } })

    const saved = await save(w, { pre_attesters: [w.bosseId], project_attesters: [{ project: 'P100', attesters: [w.petraId] }] })
    expect(saved.status, JSON.stringify(await json(saved.clone()))).toBe(200)
    expect(await json(saved)).toMatchObject({
      data: { policy: { pre_attesters: [w.bosseId], project_attesters: { P100: [w.petraId] } }, projects: [{ code: 'P100' }, { code: 'P200' }] },
    })
    // A save that does not touch the förattest (as before #192) keeps it.
    expect((await save(w, { threshold_amount: 1000 })).status).toBe(200)
    const { rows } = await getPool().query<{ pre: string[]; projects: Record<string, string[]>; threshold: string }>(
      `SELECT pre_attesters::text[] AS pre, project_attesters AS projects, threshold_amount::text AS threshold FROM public.company_attest_policies WHERE company_id = $1`,
      [w.companyId],
    )
    expect(rows[0]).toEqual({ pre: [w.bosseId], projects: { P100: [w.petraId] }, threshold: '1000.00' })

    // The change is in the audit trail behandlingshistorik reads.
    const { rows: logged } = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.audit_log WHERE company_id = $1 AND table_name = 'company_attest_policies' AND new_state->'project_attesters' ? 'P100'`,
      [w.companyId],
    )
    expect(logged[0]!.n).toBeGreaterThanOrEqual(1)

    // The shape is held by the database too.
    await expect(
      getPool().query(`UPDATE public.company_attest_policies SET project_attesters = '{"P100": []}'::jsonb WHERE company_id = $1`, [w.companyId]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'company_attest_policies_project_attesters_check' })
  })
})
