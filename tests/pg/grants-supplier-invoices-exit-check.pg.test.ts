/**
 * The exit check of grants slice 2, as one pg-real walk through production
 * code against the real schema:
 *
 *   "An agent stages a known supplier's invoice from the inbox five times
 *    the same way, each approved by the owner; the system proposes
 *    'Godkänn <leverantör> automatiskt nästa gång, upp till X kr?'; the agent
 *    cannot accept it, the owner does, in the app; the next invoice from that
 *    supplier, staged by the agent, is registered and booked at once with
 *    the rule on its receipt; one above the limit, one on another account
 *    and one from another supplier wait for a person; the owner sees the
 *    posting under 'Bokfört enligt regel' with its invoice, revokes the rule
 *    and gets the postings it let through; behandlingshistorik dates the
 *    rule and its revocation."
 *
 * Every staging goes through the MCP tool
 * gnubok_create_supplier_invoice_from_inbox and the dispatcher's grant door
 * (src/extensions/general/mcp-server/grant-door.ts), every approval through
 * commitPendingOperation, the executor every approval door ends in. The
 * detector is the bus subscription lib/init registers, switched on here
 * with GRANT_SUGGESTIONS, and the master switch is proven off for this type
 * too (no suggestion, no claim, an existing rule stops applying).
 *
 * What is not real: the HTTP hop to PostgREST, replaced by
 * tests/pg/postgrest-over-pg.ts exactly as in the slice 1 exit check (every
 * request must stay inside the shim's grammar, asserted after each test).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { commitPendingOperation } from '@/lib/pending-operations/commit'
import { listOpenSuggestions } from '@/lib/suggestions/list'
import { runEventDetectors } from '@/lib/suggestions/handler'
import { loadGrantReview } from '@/lib/grants/review'
import { stageGrantRevocation } from '@/lib/grants/actions'
import { generateBehandlingshistorik } from '@/lib/reports/behandlingshistorik'
import { createLogger } from '@/lib/logger'
import type { PendingOperation, SupplierInvoice } from '@/types'
import { tools } from '@/extensions/general/mcp-server/server'
import { applyGrantDoor, type GrantDoorActor } from '@/extensions/general/mcp-server/grant-door'
import { seedCompany } from './fixtures'
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

const previousFlag = process.env.GRANT_SUGGESTIONS
beforeAll(() => {
  process.env.GRANT_SUGGESTIONS = 'true'
})
afterAll(() => {
  if (previousFlag === undefined) delete process.env.GRANT_SUGGESTIONS
  else process.env.GRANT_SUGGESTIONS = previousFlag
})

afterEach(() => {
  const unsupported = shim.rest?.unsupported.splice(0) ?? []
  expect(unsupported).toEqual([])
})

const log = createLogger('grants-supplier-invoices-exit-check')
const fromInbox = tools.find((t) => t.name === 'gnubok_create_supplier_invoice_from_inbox')!

interface World {
  userId: string
  companyId: string
  fiscalPeriodId: string
  apiKeyId: string
  supplierId: string
  actor: GrantDoorActor & { type: 'api_key' }
}

async function seedWorld(): Promise<World> {
  const { userId, companyId, fiscalPeriodId } = await seedCompany()
  await getPool().query(`SELECT public.seed_chart_of_accounts($1::uuid, 'aktiebolag')`, [companyId])
  await getPool().query(
    `INSERT INTO public.company_settings (company_id, entity_type, vat_registered, accounting_method)
     VALUES ($1, 'aktiebolag', true, 'accrual')
     ON CONFLICT (company_id) DO UPDATE SET entity_type = 'aktiebolag', vat_registered = true, accounting_method = 'accrual'`,
    [companyId],
  )
  const apiKeyId = randomUUID()
  await getPool().query(
    `INSERT INTO public.api_keys (id, user_id, company_id, key_hash, key_prefix, name, scopes)
     VALUES ($1, $2, $3, $4, 'gnubok_sk_test', 'Claude', NULL)`,
    [apiKeyId, userId, companyId, randomUUID().replaceAll('-', '')],
  )
  const supplierId = await supplier({ userId, companyId }, 'Telia Sverige AB', '5561234567')
  return {
    userId,
    companyId,
    fiscalPeriodId,
    apiKeyId,
    supplierId,
    actor: { type: 'api_key', id: apiKeyId, label: 'Claude', unattendedCommitLimit: null, oauthKey: false, serviceAccountId: null },
  }
}

async function supplier(w: Pick<World, 'userId' | 'companyId'>, name: string, orgNumber: string): Promise<string> {
  const { rows } = await getPool().query(
    `INSERT INTO public.suppliers (user_id, company_id, name, org_number, supplier_type, default_expense_account)
     VALUES ($1, $2, $3, $4, 'swedish_business', '6212') RETURNING id`,
    [w.userId, w.companyId, name, orgNumber],
  )
  return rows[0].id as string
}

/** A supplier invoice in the inbox: its document in the archive and what extraction read off it. */
async function inboxInvoice(
  w: World,
  opts: { amount?: number; date: string; supplierId?: string; supplierName?: string; account?: string },
): Promise<string> {
  const amount = opts.amount ?? 1249
  const net = Math.round((amount / 1.25) * 100) / 100
  const vat = Math.round((amount - net) * 100) / 100
  const { rows: doc } = await getPool().query(
    `INSERT INTO public.document_attachments (user_id, company_id, storage_path, file_name, sha256_hash)
     VALUES ($1, $2, $3, 'faktura.pdf', $4) RETURNING id`,
    [w.userId, w.companyId, `${w.companyId}/${randomUUID()}.pdf`, randomUUID().replaceAll('-', '').padEnd(64, '0')],
  )
  const extracted = {
    documentKind: 'supplier_invoice',
    supplier: { name: opts.supplierName ?? 'Telia Sverige AB' },
    invoice: { invoiceNumber: `F-${randomUUID().slice(0, 8)}`, invoiceDate: opts.date, dueDate: '2026-12-31', currency: 'SEK' },
    totals: { subtotal: net, vat, total: amount },
    lineItems: [
      { description: 'Mobilabonnemang', quantity: 1, unitPrice: net, lineTotal: net, vatRate: 25, ...(opts.account ? { accountSuggestion: opts.account } : {}) },
    ],
  }
  const { rows } = await getPool().query(
    `INSERT INTO public.invoice_inbox_items (user_id, company_id, document_id, matched_supplier_id, extracted_data, kind_hint)
     VALUES ($1, $2, $3, $4, $5, 'supplier_invoice') RETURNING id`,
    [w.userId, w.companyId, doc[0].id, opts.supplierId ?? w.supplierId, JSON.stringify(extracted)],
  )
  return rows[0].id as string
}

/** What the agent does: the MCP tool stages, the dispatcher's grant door decides. */
async function agentStages(w: World, inboxItemId: string, extra: Record<string, unknown> = {}) {
  const supabase = createServiceClientNoCookies()
  const args = { inbox_item_id: inboxItemId, ...extra }
  const staged = await fromInbox.execute(args, w.companyId, w.userId, supabase, w.actor)
  return (await applyGrantDoor(staged, {
    toolName: 'gnubok_create_supplier_invoice_from_inbox',
    toolArgs: args,
    supabase,
    companyId: w.companyId,
    userId: w.userId,
    actor: w.actor,
    log,
  })) as Record<string, unknown>
}

async function pendingOperation(id: string): Promise<PendingOperation> {
  const { rows } = await getPool().query(`SELECT * FROM public.pending_operations WHERE id = $1`, [id])
  return rows[0] as PendingOperation
}

/** The owner approves in the app. */
async function ownerApproves(w: World, operationId: string) {
  return commitPendingOperation(createServiceClientNoCookies(), w.userId, w.companyId, await pendingOperation(operationId), {
    commitMethod: 'user_accept',
    actor: { type: 'user', label: 'owner@example.se' },
  })
}

async function registered(supplierInvoiceId: string): Promise<SupplierInvoice> {
  const { rows } = await getPool().query(`SELECT * FROM public.supplier_invoices WHERE id = $1`, [supplierInvoiceId])
  return rows[0] as SupplierInvoice
}

/** The detector, as the bus subscription runs it after a registration. */
async function detectorsAfter(w: World, supplierInvoiceId: string) {
  await runEventDetectors({
    type: 'supplier_invoice.registered',
    payload: { supplierInvoice: await registered(supplierInvoiceId), userId: w.userId, companyId: w.companyId },
  })
}

/** Five invoices from the supplier, each staged by the agent and approved by the owner. */
async function fiveApproved(w: World): Promise<string> {
  let last = ''
  for (const [i, amount] of [1249, 1249, 1349, 1249, 1249].entries()) {
    const staged = await agentStages(w, await inboxInvoice(w, { amount, date: `2026-0${i + 1}-03` }))
    expect(staged).toMatchObject({ staged: true, operation_id: expect.any(String) })
    expect(staged.grant).toBeUndefined()
    expect((await pendingOperation(staged.operation_id as string)).status).toBe('pending')
    const approved = await ownerApproves(w, staged.operation_id as string)
    expect(approved).toMatchObject({ status: 'committed', data: { registration_journal_entry_id: expect.any(String) } })
    last = (approved.data as { supplier_invoice_id: string }).supplier_invoice_id
  }
  return last
}

describe('grants slice 2 exit check: a known supplier invoice suggested, accepted by the person, enforced exactly, reviewed and revoked', () => {
  it('walks the whole slice', async () => {
    const w = await seedWorld()
    const supabase = createServiceClientNoCookies()

    // 1. Five Telia invoices, each staged by the agent and approved by the
    //    owner. Nothing books on its own before a rule exists.
    const lastInvoice = await fiveApproved(w)

    // 2. The detector proposes the rule as a suggestion: the bus subscription
    //    did on the fifth approval (its own registration counts), and once more
    //    by hand changes nothing (staging is idempotent per key).
    expect(await listOpenSuggestions(supabase, w.companyId)).toHaveLength(1)
    await detectorsAfter(w, lastInvoice)
    const open = await listOpenSuggestions(supabase, w.companyId)
    expect(open).toHaveLength(1)
    expect(open[0]).toMatchObject({
      detector: 'grant-candidate',
      operation_type: 'create_grant',
      suggestion_key: `create_grant:supplier-${w.supplierId}`,
      // Swedish grouping: a no-break space.
      title: 'Godkänn Telia Sverige AB automatiskt nästa gång, upp till 1\u00a0500 kr?',
      reason: expect.stringMatching(/^Samma leverantör bokförd på samma sätt 5 gånger \(konto 6212, moms 25 %\)\./),
    })
    const suggestion = await pendingOperation(open[0].pending_operation_id)
    expect(suggestion).toMatchObject({ actor_type: 'system', risk_level: 'high', status: 'pending' })
    expect(suggestion.params).toMatchObject({
      operation_type: 'create_supplier_invoice_from_inbox',
      supplier_id: w.supplierId,
      pattern: { vat_treatment: 'standard_25', reverse_charge_kind: null, item_lines: ['6212:25'], line_accounts: ['2440', '2641', '6212'] },
      amount_limit_sek: 1500,
    })

    // 3. The agent cannot accept its own authority, through any key type.
    for (const type of ['api_key', 'mcp_oauth', 'service_account', 'agent_chat'] as const) {
      const byAgent = await commitPendingOperation(supabase, w.userId, w.companyId, suggestion, {
        commitMethod: type === 'agent_chat' ? 'user_accept' : 'api_key',
        actor: { type, label: 'Claude' },
      })
      expect(byAgent, type).toMatchObject({ status: 'failed', code: 'GRANT_NEEDS_PERSON', operation_status: 'pending' })
    }
    expect((await pendingOperation(suggestion.id)).status).toBe('pending')

    //    The owner says yes in Att göra, approving it as a person in the app.
    const accepted = await ownerApproves(w, suggestion.id)
    expect(accepted).toMatchObject({ status: 'committed', data: { version: 1, amount_limit_sek: 1500, superseded_grant_id: null } })
    const grantId = (accepted.data as { grant_id: string }).grant_id
    expect(await listOpenSuggestions(supabase, w.companyId)).toEqual([])

    // 4. The next Telia invoice, staged by the agent, is registered and booked at once under the rule.
    const sixthItem = await inboxInvoice(w, { amount: 1299, date: '2026-06-03' })
    const booked = await agentStages(w, sixthItem)
    expect(booked).toMatchObject({
      staged: true,
      operation_status: 'committed',
      grant: { applied: true, status: 'committed', grant_id: grantId, grant_version: 1, amount_sek: 1299 },
      message: expect.stringMatching(/^Registered and booked without approval under the company's rule for this supplier/),
    })
    expect(booked.approve).toBeUndefined()
    const bookedOp = await pendingOperation(booked.operation_id as string)
    expect(bookedOp.status).toBe('committed')
    expect(bookedOp.result_data).toMatchObject({ grant: { grant_id: grantId, grant_version: 1 }, supplier_invoice_id: expect.any(String) })
    const journalEntryId = (booked.grant as { journal_entry_id: string }).journal_entry_id
    const supplierInvoiceId = (bookedOp.result_data as { supplier_invoice_id: string }).supplier_invoice_id
    const { rows: entry } = await getPool().query(
      `SELECT je.status, je.committed_actor_type, je.committed_actor_label, je.commit_method, si.registration_journal_entry_id, si.supplier_id,
              (SELECT array_agg(DISTINCT account_number ORDER BY account_number) FROM public.journal_entry_lines WHERE journal_entry_id = je.id) AS accounts
         FROM public.journal_entries je JOIN public.supplier_invoices si ON si.registration_journal_entry_id = je.id
        WHERE je.id = $1`,
      [journalEntryId],
    )
    expect(entry[0]).toEqual({
      status: 'posted', committed_actor_type: 'api_key', committed_actor_label: 'Claude', commit_method: 'api_key',
      registration_journal_entry_id: journalEntryId, supplier_id: w.supplierId, accounts: ['2440', '2641', '6212'],
    })
    const { rows: item } = await getPool().query(`SELECT created_supplier_invoice_id FROM public.invoice_inbox_items WHERE id = $1`, [sixthItem])
    expect(item[0].created_supplier_invoice_id).toBe(supplierInvoiceId)
    const { rows: receipt } = await getPool().query(
      `SELECT policy_version, confidence_band, actor_type FROM public.suggestion_log
        WHERE company_id = $1 AND pending_operation_id = $2 AND kind = 'operation'`,
      [w.companyId, bookedOp.id],
    )
    expect(receipt).toEqual([{ policy_version: `grant.1;grant_id=${grantId};grant_version=1`, confidence_band: 'direct', actor_type: 'api_key' }])
    const { rows: use } = await getPool().query(
      `SELECT status, pattern_verified, journal_entry_id, inbox_item_id FROM public.company_grant_uses WHERE pending_operation_id = $1`,
      [bookedOp.id],
    )
    expect(use).toEqual([{ status: 'committed', pattern_verified: true, journal_entry_id: journalEntryId, inbox_item_id: sixthItem }])

    // 5. Above the limit, on another account, and from another supplier: each waits for a person, as today.
    const above = await agentStages(w, await inboxInvoice(w, { amount: 1999, date: '2026-06-10' }))
    expect(above).toMatchObject({ staged: true, grant: { applied: false, reason: 'above_limit' }, approve: expect.any(Object) })
    expect((await pendingOperation(above.operation_id as string)).status).toBe('pending')
    const otherWay = await agentStages(w, await inboxInvoice(w, { amount: 1249, date: '2026-06-11' }), {
      line_overrides: [{ line_number: 1, account_number: '6540' }],
    })
    expect(otherWay).toMatchObject({ staged: true, grant: { applied: false, reason: 'pattern_mismatch' } })
    expect((await pendingOperation(otherWay.operation_id as string)).status).toBe('pending')
    const tele2 = await supplier(w, 'Tele2 Sverige AB', '5569876543')
    const otherSupplier = await agentStages(w, await inboxInvoice(w, { amount: 1249, date: '2026-06-12', supplierId: tele2, supplierName: 'Tele2 Sverige AB' }))
    expect(otherSupplier.grant).toBeUndefined()
    expect((await pendingOperation(otherSupplier.operation_id as string)).status).toBe('pending')

    // 6. The owner sees it under "Bokfört enligt regel", with its invoice.
    const review = await loadGrantReview(supabase, w.companyId)
    expect(review).toMatchObject({ paused: false, has_active_grants: true })
    expect(review.postings).toEqual([
      expect.objectContaining({
        grant_id: grantId, operation_type: 'create_supplier_invoice_from_inbox', journal_entry_id: journalEntryId, amount_sek: 1299,
        counterparty_label: 'Telia Sverige AB', supplier_invoice_id: supplierInvoiceId, inbox_item_id: sixthItem, transaction_id: null,
        item_lines: ['6212:25'], entry_status: 'posted', pattern_verified: true,
      }),
    ])

    // 7. The owner revokes the rule: a staged revoke_grant, approved, answering what it let through.
    const revocation = await stageGrantRevocation(supabase, supabase, { companyId: w.companyId, userId: w.userId, userLabel: 'owner@example.se', grantId }, log)
    expect(revocation).toMatchObject({ ok: true })
    const revoked = await ownerApproves(w, (revocation as { operationId: string }).operationId)
    expect(revoked).toMatchObject({
      status: 'committed',
      data: {
        grant_id: grantId, operation_type: 'create_supplier_invoice_from_inbox', changed: true, postings_count: 1,
        postings: [expect.objectContaining({ journal_entry_id: journalEntryId, supplier_invoice_id: supplierInvoiceId, inbox_item_id: sixthItem, amount_sek: 1299 })],
      },
    })
    const afterRevoke = await agentStages(w, await inboxInvoice(w, { amount: 1249, date: '2026-06-20' }))
    expect(afterRevoke.grant).toBeUndefined()
    expect((await pendingOperation(afterRevoke.operation_id as string)).status).toBe('pending')

    // 8. Behandlingshistorik: the rule accepted and revoked as dated lines, the posting's decision naming the rule.
    const report = await generateBehandlingshistorik(supabase, w.companyId, { periodId: w.fiscalPeriodId })
    const acceptedLine = report!.events.find((e) => e.code === 'grant.accepted')
    expect(acceptedLine).toMatchObject({
      category: 'installningar',
      event: 'Regel för automatisk bokföring godkänd',
      object: 'Regel för automatisk bokföring av leverantörsfakturor: Telia Sverige AB, upp till 1\u00a0500 kr inklusive moms',
      actor: expect.objectContaining({ type: 'user' }),
    })
    expect(acceptedLine!.details).toEqual(
      expect.arrayContaining([
        'Version: 1',
        `Leverantör: Telia Sverige AB (${w.supplierId})`,
        'Fakturarader: konto 6212 moms 25 %',
        'Momsbehandling: moms 25 %',
        'Konton i verifikatet: 2440, 2641, 6212',
      ]),
    )
    expect(report!.events.find((e) => e.code === 'grant.revoked')).toMatchObject({ event: 'Regel för automatisk bokföring återkallad' })
    expect(report!.events.some((e) => e.event === 'Bokfört automatiskt enligt regel')).toBe(true)
  }, 60_000)

  it('turns a supplier rule that exists off with GRANT_SUGGESTIONS: the next matching invoice waits for a person', async () => {
    const w = await seedWorld()
    const { rows } = await getPool().query(
      `SELECT public.create_company_grant(
         p_company_id => $1, p_decided_by => $2, p_actor_type => 'user', p_actor_label => 'owner@example.se', p_pending_operation_id => NULL,
         p_operation_type => 'create_supplier_invoice_from_inbox', p_counterparty_key => NULL, p_counterparty_label => 'Telia Sverige AB',
         p_direction => 'out', p_category => NULL, p_vat_treatment => 'standard_25', p_reverse_charge_kind => NULL, p_account_number => NULL,
         p_line_accounts => ARRAY['2440','2641','6212'], p_amount_limit_sek => 5000, p_monthly_limit_sek => NULL, p_credential_scope => 'any',
         p_credential_id => NULL, p_evidence => '{}'::jsonb, p_supplier_id => $3, p_item_lines => ARRAY['6212:25']) AS r`,
      [w.companyId, w.userId, w.supplierId],
    )
    expect(rows[0].r).toMatchObject({ ok: true })
    process.env.GRANT_SUGGESTIONS = 'false'
    try {
      const staged = await agentStages(w, await inboxInvoice(w, { amount: 1249, date: '2026-06-05' }))
      expect(staged.grant).toBeUndefined()
      expect((await pendingOperation(staged.operation_id as string)).status).toBe('pending')
      const { rows: uses } = await getPool().query(`SELECT count(*)::int AS n FROM public.company_grant_uses WHERE company_id = $1`, [w.companyId])
      expect(uses[0].n).toBe(0)
    } finally {
      process.env.GRANT_SUGGESTIONS = 'true'
    }
    // Back on, the same kind of invoice books under the rule.
    const booked = await agentStages(w, await inboxInvoice(w, { amount: 1249, date: '2026-06-06' }))
    expect(booked).toMatchObject({ operation_status: 'committed', grant: { applied: true, status: 'committed' } })
  }, 30_000)

  it('stages nothing and books nothing unattended while GRANT_SUGGESTIONS is off and no rule exists', async () => {
    process.env.GRANT_SUGGESTIONS = 'false'
    try {
      const w = await seedWorld()
      const supabase = createServiceClientNoCookies()
      const lastInvoice = await fiveApproved(w)
      await detectorsAfter(w, lastInvoice)
      expect(await listOpenSuggestions(supabase, w.companyId)).toEqual([])
      const sixth = await agentStages(w, await inboxInvoice(w, { amount: 1249, date: '2026-06-05' }))
      expect(sixth.grant).toBeUndefined()
      expect((await pendingOperation(sixth.operation_id as string)).status).toBe('pending')
      const { rows } = await getPool().query(`SELECT count(*)::int AS n FROM public.company_grants WHERE company_id = $1`, [w.companyId])
      expect(rows[0].n).toBe(0)
    } finally {
      process.env.GRANT_SUGGESTIONS = 'true'
    }
  }, 60_000)
})
