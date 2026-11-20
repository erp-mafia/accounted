/**
 * The attest marker (#124, migration 20261028214917).
 *
 * supplier_invoices.approved_at is what payments read to decide whether an
 * invoice the attest policy governs may be paid. Until this migration any
 * writing member could set it through PostgREST and skip the policy. Here:
 *
 *   1. a member's own session cannot set, change or clear approved_at or
 *      approved_by (the case of the issue: a registrant who is no attester),
 *      while edits that leave the marker alone still work;
 *   2. every door that legitimately attests still does, through production
 *      code against the real schema: the dashboard without a policy and below
 *      the policy's threshold, an attester under the policy, the mail's link,
 *      v1, the approved agent operation (MCP) and kontantmetoden;
 *   3. the agent's attest is priced by its key's unattended ceiling;
 *   4. policy changes are in audit_log and behandlingshistorik_sources;
 *   5. the attest trail cannot lose its attester.
 *
 * What is not real: the HTTP hop to PostgREST, replaced by
 * tests/pg/postgrest-over-pg.ts as in the grants exit checks (every request
 * must stay inside the shim's grammar, asserted after each test). The
 * dashboard's session is a member's own authenticated client, so RLS and the
 * new trigger see what they would see in production.
 */
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { createServiceClientNoCookies, generateApiKey } from '@/lib/auth/api-keys'
import { commitPendingOperation } from '@/lib/pending-operations/commit'
import { mintAttestLink } from '@/lib/supplier-invoices/attest-links'
import { loadAttestBlockedInvoiceIds } from '@/lib/supplier-invoices/attest-policy-read'
import type { PendingOperation } from '@/types'
import { tools } from '@/extensions/general/mcp-server/server'
import type { ActorContext } from '@/extensions/general/mcp-server/server'
import { POST as approveRoute } from '@/app/api/supplier-invoices/[id]/approve/route'
import { POST as v1ApproveRoute } from '@/app/api/v1/companies/[companyId]/supplier-invoices/[id]/approve/route'
import { POST as attestDecisionRoute } from '@/app/api/attest/[token]/decision/route'
import { insertAuthUser, insertCompanyMember, seedCompany, setActiveCompany } from './fixtures'
import { getPool, runAsServiceRole, withUserContext } from './setup'
import { createPgRest, type PgRest } from './postgrest-over-pg'

const shim = vi.hoisted(() => ({ rest: null as PgRest | null }))
/** Who the dashboard door runs as, and the session client it gets (memberClient, set below). */
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
// The dashboard door: the signed-in member on their own session, through RLS.
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
 * A company under faktureringsmetoden (or kontantmetoden) with three people
 * who keep the books: the owner, Anna (an attester when a policy is on) and
 * Cilla, who registers the invoices and is no attester.
 */
interface World {
  ownerId: string
  annaId: string
  cillaId: string
  companyId: string
  supplierId: string
}

async function seedWorld(accountingMethod: 'accrual' | 'cash' = 'accrual'): Promise<World> {
  const { userId: ownerId, companyId } = await seedCompany()
  const annaId = await insertAuthUser()
  const cillaId = await insertAuthUser()
  await insertCompanyMember({ companyId, userId: annaId, role: 'member' })
  await insertCompanyMember({ companyId, userId: cillaId, role: 'member' })
  for (const id of [ownerId, annaId, cillaId]) await setActiveCompany(id, companyId)
  await getPool().query(
    `INSERT INTO public.company_settings (company_id, entity_type, vat_registered, accounting_method)
     VALUES ($1, 'aktiebolag', true, $2)
     ON CONFLICT (company_id) DO UPDATE SET accounting_method = EXCLUDED.accounting_method`,
    [companyId, accountingMethod],
  )
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.suppliers (user_id, company_id, name) VALUES ($1, $2, 'Kontorsvaror AB') RETURNING id::text`,
    [ownerId, companyId],
  )
  return { ownerId, annaId, cillaId, companyId, supplierId: rows[0]!.id }
}

/** An unattested invoice Cilla registered, due well ahead (so it attests to 'approved', not 'overdue'). */
async function registeredInvoice(w: World, total = 10000): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.supplier_invoices
       (id, user_id, company_id, supplier_id, arrival_number, supplier_invoice_number, invoice_date, due_date,
        subtotal, vat_amount, total, remaining_amount)
     VALUES ($1, $2, $3, $4, floor(random() * 1000000)::int, $5, '2026-10-01', '2099-12-31', $6, $7, $8, $8)`,
    [id, w.cillaId, w.companyId, w.supplierId, `F-${id.slice(0, 8)}`, total * 0.8, total * 0.2, total],
  )
  return id
}

/** The policy as an owner saves it; `attesters` default to Anna. */
async function policy(w: World, overrides: { threshold?: number | null; attesters?: string[] } = {}): Promise<void> {
  await getPool().query(
    `INSERT INTO public.company_attest_policies (company_id, enabled, threshold_amount, mode, attesters, preparer_may_attest, updated_by)
     VALUES ($1, true, $2, 'any', $3::uuid[], false, $4)`,
    [w.companyId, overrides.threshold ?? null, overrides.attesters ?? [w.annaId], w.ownerId],
  )
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

async function trail(invoiceId: string): Promise<Array<{ user_id: string; decision: string; source: string }>> {
  const { rows } = await getPool().query(
    `SELECT user_id::text, decision, source FROM public.supplier_invoice_attestations WHERE supplier_invoice_id = $1 ORDER BY decided_at`,
    [invoiceId],
  )
  return rows
}

function params<T extends Record<string, string>>(value: T): { params: Promise<T> } {
  return { params: Promise.resolve(value) }
}

/** The dashboard's Attestera, as `userId`. */
async function approveInApp(w: World, userId: string, invoiceId: string): Promise<Response> {
  session.userId = userId
  session.companyId = w.companyId
  return approveRoute(
    new Request(`http://localhost/api/supplier-invoices/${invoiceId}/approve`, { method: 'POST' }),
    params({ id: invoiceId }),
  )
}

async function json(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text()
  return text ? (JSON.parse(text) as Record<string, unknown>) : {}
}

/** The guard's refusal, told apart from an RLS refusal (also 42501) by its message. */
const MARKER_REFUSED = { code: '42501', message: expect.stringMatching(/^Attesten sätts bara/) }

describe('a session cannot set the attest marker', () => {
  it('refuses a registrant who is no attester setting approved_at through PostgREST, and payment still holds the invoice', async () => {
    const w = await seedWorld()
    await policy(w)
    const invoiceId = await registeredInvoice(w)

    const { data, error } = await memberClient(w.cillaId)
      .from('supplier_invoices')
      .update({ status: 'approved', approved_at: new Date().toISOString(), approved_by: w.cillaId })
      .eq('company_id', w.companyId)
      .eq('id', invoiceId)
      .select('id')
    expect(data).toBeNull()
    expect(error).toMatchObject(MARKER_REFUSED)

    expect(await marker(invoiceId)).toMatchObject({ status: 'registered', approved_at: null, approved_by: null })
    expect(await loadAttestBlockedInvoiceIds(createServiceClientNoCookies(), w.companyId, [invoiceId])).toEqual(new Set([invoiceId]))
  })

  it('refuses every way a session could move the marker, and only the marker', async () => {
    const w = await seedWorld()
    const invoiceId = await registeredInvoice(w)
    const attestedId = await registeredInvoice(w)
    await getPool().query(`UPDATE public.supplier_invoices SET status = 'approved', approved_at = now(), approved_by = $2 WHERE id = $1`, [attestedId, w.annaId])

    // Each attempt in its own transaction: a refused statement aborts the one it ran in.
    const asCilla = (sql: string, values: unknown[]) => withUserContext(w.cillaId, (client) => client.query(sql, values))
    await expect(asCilla(`UPDATE public.supplier_invoices SET approved_at = now() WHERE id = $1`, [invoiceId])).rejects.toMatchObject(MARKER_REFUSED)
    await expect(asCilla(`UPDATE public.supplier_invoices SET approved_by = $2 WHERE id = $1`, [invoiceId, w.cillaId])).rejects.toMatchObject(MARKER_REFUSED)
    await expect(asCilla(`UPDATE public.supplier_invoices SET approved_at = NULL, status = 'registered' WHERE id = $1`, [attestedId])).rejects.toMatchObject(MARKER_REFUSED)
    await expect(asCilla(`UPDATE public.supplier_invoices SET approved_by = $2 WHERE id = $1`, [attestedId, w.cillaId])).rejects.toMatchObject(MARKER_REFUSED)
    await expect(
      asCilla(
        `INSERT INTO public.supplier_invoices
           (user_id, company_id, supplier_id, arrival_number, supplier_invoice_number, invoice_date, due_date, subtotal, vat_amount, total, approved_at)
         VALUES ($1, $2, $3, floor(random() * 1000000)::int, 'F-INSERT', '2026-10-01', '2099-12-31', 80, 20, 100, now())`,
        [w.cillaId, w.companyId, w.supplierId],
      ),
    ).rejects.toMatchObject(MARKER_REFUSED)

    // Writes that leave the marker as it is go through: an edit, a status
    // flip, a statement that names the column with its own value, and a new
    // invoice without it.
    await withUserContext(w.cillaId, async (client) => {
      const inserted = await client.query(
        `INSERT INTO public.supplier_invoices
           (user_id, company_id, supplier_id, arrival_number, supplier_invoice_number, invoice_date, due_date, subtotal, vat_amount, total)
         VALUES ($1, $2, $3, floor(random() * 1000000)::int, 'F-INSERT', '2026-10-01', '2099-12-31', 80, 20, 100)`,
        [w.cillaId, w.companyId, w.supplierId],
      )
      expect(inserted.rowCount).toBe(1)
      expect((await client.query(`UPDATE public.supplier_invoices SET notes = 'Kollad' WHERE id = $1`, [attestedId])).rowCount).toBe(1)
      expect((await client.query(`UPDATE public.supplier_invoices SET status = 'overdue' WHERE id = $1`, [invoiceId])).rowCount).toBe(1)
      expect((await client.query(`UPDATE public.supplier_invoices SET approved_at = approved_at, approved_by = approved_by WHERE id = $1`, [attestedId])).rowCount).toBe(1)
    })

    // The attest service's own write, as the service role.
    await runAsServiceRole(async (service) => {
      const set = await service.query(
        `UPDATE public.supplier_invoices SET status = 'approved', approved_at = now(), approved_by = $2 WHERE id = $1 AND approved_at IS NULL`,
        [invoiceId, w.annaId],
      )
      expect(set.rowCount).toBe(1)
    })
    expect(await marker(invoiceId)).toMatchObject({ approved_by: w.annaId })
  })
})

describe('every door that attests still does', () => {
  it('the dashboard without a policy: the member attests, the marker and the trail are set', async () => {
    const w = await seedWorld()
    const invoiceId = await registeredInvoice(w)
    const response = await approveInApp(w, w.cillaId, invoiceId)
    expect(response.status, JSON.stringify(await json(response.clone()))).toBe(200)
    expect(await json(response)).toMatchObject({ data: { id: invoiceId, status: 'approved', attest: { approved: true, required: false } } })
    expect(await marker(invoiceId)).toMatchObject({ status: 'approved', approved_by: w.cillaId, approved_at: expect.any(Date) })
    expect(await trail(invoiceId)).toEqual([{ user_id: w.cillaId, decision: 'approved', source: 'app' }])
  })

  it('the dashboard under a policy: below the threshold anyone attests, above it only an attester', async () => {
    const w = await seedWorld()
    await policy(w, { threshold: 50000 })
    const small = await registeredInvoice(w, 10000)
    const large = await registeredInvoice(w, 80000)

    const below = await approveInApp(w, w.cillaId, small)
    expect(below.status, JSON.stringify(await json(below.clone()))).toBe(200)
    expect(await marker(small)).toMatchObject({ status: 'approved', approved_by: w.cillaId })

    const refused = await approveInApp(w, w.cillaId, large)
    expect(refused.status).toBe(403)
    expect(await json(refused)).toMatchObject({ error: { code: 'ATTEST_NOT_ALLOWED' } })
    expect(await marker(large)).toMatchObject({ approved_at: null })

    const attester = await approveInApp(w, w.annaId, large)
    expect(attester.status, JSON.stringify(await json(attester.clone()))).toBe(200)
    expect(await marker(large)).toMatchObject({ status: 'approved', approved_by: w.annaId })
    expect(await trail(large)).toEqual([{ user_id: w.annaId, decision: 'approved', source: 'app' }])
  })

  it("the mail's link: the attester's Godkänn attests without a login and uses up the link", async () => {
    const w = await seedWorld()
    await policy(w)
    const invoiceId = await registeredInvoice(w)
    const link = await mintAttestLink(createServiceClientNoCookies(), { companyId: w.companyId, invoiceId, attesterUserId: w.annaId })

    const response = await attestDecisionRoute(
      new Request(`http://localhost/api/attest/${link.token}/decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'approve' }),
      }),
      params({ token: link.token }),
    )
    expect(response.status, JSON.stringify(await json(response.clone()))).toBe(200)
    expect(await json(response)).toMatchObject({ data: { decision: 'approved', attested: true } })
    expect(await marker(invoiceId)).toMatchObject({ status: 'approved', approved_by: w.annaId })
    expect(await trail(invoiceId)).toEqual([{ user_id: w.annaId, decision: 'approved', source: 'email_link' }])
    const { rows } = await getPool().query(`SELECT consumed_at FROM public.supplier_invoice_attest_links WHERE id = $1`, [link.link_id])
    expect(rows[0]!.consumed_at).not.toBeNull()
  })

  it("v1: the key's owner, an attester, attests through the API", async () => {
    const w = await seedWorld()
    await policy(w, { attesters: [w.ownerId] })
    const invoiceId = await registeredInvoice(w)
    const key = generateApiKey('live')
    await getPool().query(
      `INSERT INTO public.api_keys (user_id, company_id, key_hash, key_prefix, name, scopes)
       VALUES ($1, $2, $3, $4, 'Attestnyckel', $5)`,
      [w.ownerId, w.companyId, key.hash, key.prefix, ['suppliers:read', 'suppliers:write']],
    )

    const response = await v1ApproveRoute(
      new Request(`http://localhost/api/v1/companies/${w.companyId}/supplier-invoices/${invoiceId}/approve`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key.key}`, 'Idempotency-Key': `attest-marker-${randomUUID()}` },
      }),
      params({ companyId: w.companyId, id: invoiceId }),
    )
    expect(response.status, JSON.stringify(await json(response.clone()))).toBe(200)
    expect(await json(response)).toMatchObject({ data: { id: invoiceId, status: 'approved', attest: { approved: true, required: true } } })
    expect(await marker(invoiceId)).toMatchObject({ status: 'approved', approved_by: w.ownerId })
    expect(await trail(invoiceId)).toEqual([{ user_id: w.ownerId, decision: 'approved', source: 'api' }])
  })

  it("MCP: the agent's attest is priced by its key's ceiling, and attests once a person approves it", async () => {
    const w = await seedWorld()
    await policy(w, { attesters: [w.ownerId] })
    const invoiceId = await registeredInvoice(w, 10000)
    const apiKeyId = randomUUID()
    await getPool().query(
      `INSERT INTO public.api_keys (id, user_id, company_id, key_hash, key_prefix, name, scopes, unattended_commit_limit)
       VALUES ($1, $2, $3, $4, 'gnubok_sk_test', 'Claude', NULL, 5000)`,
      [apiKeyId, w.ownerId, w.companyId, randomUUID().replaceAll('-', '')],
    )
    const actor: ActorContext = { type: 'api_key', id: apiKeyId, label: 'Claude', unattendedCommitLimit: 5000, oauthKey: false, serviceAccountId: null }
    const tool = tools.find((t) => t.name === 'gnubok_approve_supplier_invoice')!
    const staged = (await tool.execute({ supplier_invoice_id: invoiceId }, w.companyId, w.ownerId, createServiceClientNoCookies(), actor)) as Record<string, unknown>
    expect(staged).toMatchObject({ staged: true, operation_id: expect.any(String) })

    const pendingOperation = async () => {
      const { rows } = await getPool().query(`SELECT * FROM public.pending_operations WHERE id = $1`, [staged.operation_id])
      return rows[0] as PendingOperation
    }
    expect((await pendingOperation()).preview_data).toMatchObject({ total: 10000, currency: 'SEK', total_sek: 10000 })

    // The agent approves its own staging: 10 000 kr is over its 5 000 kr ceiling.
    const byAgent = await commitPendingOperation(createServiceClientNoCookies(), w.ownerId, w.companyId, await pendingOperation(), {
      commitMethod: 'api_key',
      actor: { type: 'api_key', label: 'Claude', unattendedCommitLimit: 5000 },
    })
    expect(byAgent).toMatchObject({ status: 'failed', code: 'UNATTENDED_COMMIT_LIMIT_EXCEEDED', unattended_limit: { attempted: 10000, limit: 5000 } })
    expect((await pendingOperation()).status).toBe('pending')
    expect(await marker(invoiceId)).toMatchObject({ approved_at: null })

    // The owner approves it in the app.
    const byOwner = await commitPendingOperation(createServiceClientNoCookies(), w.ownerId, w.companyId, await pendingOperation(), {
      commitMethod: 'user_accept',
      actor: { type: 'user', label: 'owner@example.se' },
    })
    expect(byOwner, JSON.stringify(byOwner)).toMatchObject({ status: 'committed' })
    expect(await marker(invoiceId)).toMatchObject({ status: 'approved', approved_by: w.ownerId })
    expect(await trail(invoiceId)).toEqual([{ user_id: w.ownerId, decision: 'approved', source: 'mcp' }])
  })

  it('kontantmetoden: no attest step, so the policy does not hold anyone back', async () => {
    const w = await seedWorld('cash')
    await policy(w)
    const invoiceId = await registeredInvoice(w)
    const response = await approveInApp(w, w.cillaId, invoiceId)
    expect(response.status, JSON.stringify(await json(response.clone()))).toBe(200)
    expect(await json(response)).toMatchObject({ data: { attest: { approved: true, required: false } } })
    expect(await marker(invoiceId)).toMatchObject({ status: 'approved', approved_by: w.cillaId })
  })
})

describe('policy changes are dated in audit_log and behandlingshistorik', () => {
  it('logs the first save and each change of a rule as the person who made it, not a save that changes nothing', async () => {
    const w = await seedWorld()
    const adminId = await insertAuthUser()
    await insertCompanyMember({ companyId: w.companyId, userId: adminId, role: 'admin' })
    await setActiveCompany(adminId, w.companyId)
    const { rows: period } = await getPool().query<{ id: string }>(`SELECT id::text FROM public.fiscal_periods WHERE company_id = $1`, [w.companyId])

    // Saved through a service-role door: no session, so updated_by names the person.
    await policy(w, { threshold: 5000 })

    await withUserContext(adminId, async (client) => {
      // An admin's own write that leaves updated_by as it was is still the admin's.
      await client.query(`UPDATE public.company_attest_policies SET threshold_amount = NULL, mode = 'all' WHERE company_id = $1`, [w.companyId])
      // The settings page saves the whole row: nothing changed, nothing to date.
      await client.query(`UPDATE public.company_attest_policies SET updated_by = $2 WHERE company_id = $1`, [w.companyId, adminId])

      const logged = await client.query<{ action: string; user_id: string; old_mode: string | null; new_mode: string }>(
        `SELECT action, user_id::text, old_state->>'mode' AS old_mode, new_state->>'mode' AS new_mode
           FROM public.audit_log WHERE table_name = 'company_attest_policies' AND record_id = $1
          ORDER BY created_at, action`,
        [w.companyId],
      )
      expect(logged.rows).toEqual([
        { action: 'INSERT', user_id: w.ownerId, old_mode: null, new_mode: 'any' },
        { action: 'UPDATE', user_id: adminId, old_mode: 'any', new_mode: 'all' },
      ])

      const sources = await client.query<{ audit: Array<{ table_name: string; action: string }> }>(
        `SELECT audit FROM public.behandlingshistorik_sources($1, $2, now() - interval '1 hour', now() + interval '1 hour', false)`,
        [w.companyId, period[0]!.id],
      )
      const policyRows = sources.rows[0]!.audit.filter((a) => a.table_name === 'company_attest_policies')
      expect(policyRows.map((a) => a.action).sort()).toEqual(['INSERT', 'UPDATE'])
    })
  })
})

describe('the attest trail outlives its attester', () => {
  it('keeps the attestation: the account cannot be deleted from under it', async () => {
    const w = await seedWorld()
    const invoiceId = await registeredInvoice(w)
    const departed = await insertAuthUser()
    await getPool().query(
      `INSERT INTO public.supplier_invoice_attestations (company_id, supplier_invoice_id, user_id, decision, source) VALUES ($1, $2, $3, 'approved', 'app')`,
      [w.companyId, invoiceId, departed],
    )

    const { rows: fk } = await getPool().query<{ confdeltype: string }>(
      `SELECT confdeltype FROM pg_constraint WHERE conname = 'supplier_invoice_attestations_user_id_fkey'`,
    )
    expect(fk).toEqual([{ confdeltype: 'r' }])
    await expect(getPool().query(`DELETE FROM auth.users WHERE id = $1`, [departed])).rejects.toMatchObject({
      code: '23503',
      constraint: 'supplier_invoice_attestations_user_id_fkey',
    })
    expect(await trail(invoiceId)).toEqual([{ user_id: departed, decision: 'approved', source: 'app' }])
  })
})
