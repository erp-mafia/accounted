import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { insertCashAccount, insertPostedJournalEntry, insertTransaction, seedCompany } from '@/tests/pg/fixtures'
import { getClient, getPool, runAsServiceRole, withUserContext } from '@/tests/pg/setup'

/**
 * Covers the SQL link writers that record their link basis through
 * public.resolve_link_basis (20261016180100):
 *   20261016180200 bulk_book_transactions
 *   20261016180300 match_batch_allocate
 *   20261016180400 create_expense_payout_batch
 *   20261016180500 link_invoice_to_voucher
 *   20261016180600 relink_stranded_transactions (a rule basis)
 *   20261016180700 create_document_version (carries the basis it replaces)
 *
 * For each writer: the basis it records for a person (no actor, or 'user'),
 * an API key or MCP connector (client_asserted) and cron (system_derived),
 * and that the booking itself commits exactly as before (voucher number,
 * lines, balance, links) when the actor setting is missing or garbage.
 */

type Tenant = Awaited<ReturnType<typeof seedTenant>>

/** A company with a Stripe balance (1686) and a fee account, as the bulk-book suites use. */
async function seedTenant() {
  const tenant = await seedCompany()
  await getPool().query(
    `INSERT INTO public.chart_of_accounts
       (user_id, company_id, account_number, account_name, account_class, account_type, normal_balance, is_active)
     SELECT $1, $2, n, name, cls, atype, nbal, true
     FROM (VALUES
       ('1686', 'Fordringar för kontokort och kuponger', 1, 'asset',   'debit'),
       ('6570', 'Bankkostnader',                         6, 'expense', 'debit')
     ) AS t(n, name, cls, atype, nbal)`,
    [tenant.userId, tenant.companyId],
  )
  const stripe = await insertCashAccount({ companyId: tenant.companyId, ledgerAccount: '1686', source: 'manual' })
  return { ...tenant, stripe }
}

function feeRow(tenant: Tenant, amount: number, date = '2026-09-17') {
  return insertTransaction({ ...tenant, amount, date, cashAccountId: tenant.stripe })
}

/** A posted fee verifikat (debit 6570, credit 1686) in series B, so series A numbering stays the RPC's. */
function feeVoucher(tenant: Tenant, total: number, voucherNumber = 1) {
  return insertPostedJournalEntry({
    ...tenant,
    entryDate: '2026-09-30',
    voucherSeries: 'B',
    voucherNumber,
    description: 'Stripe avgifter',
    lines: [
      { accountNumber: '6570', debitAmount: total, creditAmount: 0 },
      { accountNumber: '1686', debitAmount: 0, creditAmount: total },
    ],
  })
}

/** The samlingsverifikat payload for expense rows summing to -total on 1686. */
function newFeeEntry(total: number) {
  return JSON.stringify({
    description: 'Stripe-avgifter',
    lines: [
      { account_number: '6570', debit_amount: total, credit_amount: 0, currency: 'SEK' },
      { account_number: '1686', debit_amount: 0, credit_amount: total, currency: 'SEK' },
    ],
  })
}

/** An unlinked underlag pinned to the bank row, as /attach-document leaves it. */
async function pinDocument(tenant: Tenant, txId: string): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.document_attachments
       (id, user_id, company_id, file_name, mime_type, file_size_bytes, storage_path, sha256_hash, upload_source)
     VALUES ($1, $2, $3, 'kvitto.pdf', 'application/pdf', 100, $4, repeat('b', 64), 'file_upload')`,
    [id, tenant.userId, tenant.companyId, `documents/${tenant.companyId}/${id}.pdf`],
  )
  await getPool().query(`UPDATE public.transactions SET document_id = $2 WHERE id = $1`, [txId, id])
  return id
}

interface BulkResult {
  ok: boolean
  code?: string
  mode?: string
  journal_entry_id?: string
  voucher_series?: string
  voucher_number?: number
  linked_tx_count?: number
  tx_sum?: number
  docs_linked?: number
}

interface BulkCall {
  txIds: string[]
  existing?: string | null
  newEntry?: string | null
  actorType?: string | null
  actorLabel?: string | null
  /** gnubok.actor_type set before the call, as an enclosing SQL caller would. */
  setting?: string
}

async function callBulkBook(client: PoolClient, tenant: Tenant, call: BulkCall): Promise<BulkResult> {
  if (call.setting !== undefined) {
    await client.query(`SELECT set_config('gnubok.actor_type', $1, true)`, [call.setting])
  }
  const { rows } = await client.query<{ r: BulkResult }>(
    `SELECT public.bulk_book_transactions(
       p_tx_ids => $1::uuid[], p_existing_journal_entry_id => $2, p_new_entry => $3::jsonb,
       p_company_id => $4, p_user_id => $5, p_commit_method => NULL,
       p_actor_type => $6, p_actor_label => $7) AS r`,
    [call.txIds, call.existing ?? null, call.newEntry ?? null, tenant.companyId, tenant.userId, call.actorType ?? null, call.actorLabel ?? null],
  )
  return rows[0]!.r
}

interface LinkState {
  links: Array<{ transaction_id: string; allocated_amount: number; link_basis: string | null; link_evidence: unknown }>
  rows: Array<{ id: string; journal_entry_id: string | null; link_basis: string | null; link_evidence: unknown }>
}

async function linkState(client: PoolClient, journalEntryId: string, txIds: string[]): Promise<LinkState> {
  const links = await client.query(
    `SELECT transaction_id, allocated_amount::float8 AS allocated_amount, link_basis, link_evidence
       FROM public.transaction_voucher_links
      WHERE journal_entry_id = $1 AND role = 'bank_line'
      ORDER BY transaction_id`,
    [journalEntryId],
  )
  const rows = await client.query(
    `SELECT id, journal_entry_id, link_basis, link_evidence FROM public.transactions WHERE id = ANY($1::uuid[]) ORDER BY id`,
    [txIds],
  )
  return { links: links.rows, rows: rows.rows }
}

async function entryState(client: PoolClient, journalEntryId: string) {
  const { rows: entry } = await client.query(
    `SELECT status, voucher_series, voucher_number, committed_actor_type, committed_actor_label
       FROM public.journal_entries WHERE id = $1`,
    [journalEntryId],
  )
  const { rows: lines } = await client.query(
    `SELECT account_number, debit_amount::float8 AS debit, credit_amount::float8 AS credit
       FROM public.journal_entry_lines WHERE journal_entry_id = $1 ORDER BY sort_order`,
    [journalEntryId],
  )
  return { entry: entry[0], lines }
}

/** Book as a person: the member's own JWT, rolled back afterwards; reads run as the superuser. */
function asPerson<T>(tenant: Tenant, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return withUserContext(tenant.userId, async (client) => {
    const result = await fn(client)
    return result
  })
}

/** Book as the v1 / MCP / cron doors do: the service role, p_user_id honoured. Commits. */
function asService<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return runAsServiceRole(fn)
}

describe('bulk_book_transactions records the link basis', () => {
  it('a person linking rows to a posted verifikat: user_confirmed on every link row, no evidence', async () => {
    const tenant = await seedTenant()
    const fees = [await feeRow(tenant, -3.25), await feeRow(tenant, -4.5)]
    const voucher = await feeVoucher(tenant, 7.75)

    const state = await asPerson(tenant, async (client) => {
      const r = await callBulkBook(client, tenant, { txIds: fees, existing: voucher })
      expect(r).toMatchObject({ ok: true, mode: 'link_existing', linked_tx_count: 2, tx_sum: -7.75 })
      await client.query('RESET ROLE')
      return linkState(client, voucher, fees)
    })

    expect(state.links.map((l) => [l.link_basis, l.link_evidence])).toEqual([
      ['user_confirmed', null],
      ['user_confirmed', null],
    ])
    // Several rows on one verifikat: the junction carries the link, the pointers stay empty.
    expect(state.rows.map((r) => [r.journal_entry_id, r.link_basis])).toEqual([
      [null, null],
      [null, null],
    ])
  })

  it('one row linked: the pointer carries the same basis as its link row', async () => {
    const tenant = await seedTenant()
    const fee = await feeRow(tenant, -9)
    const voucher = await feeVoucher(tenant, 9)

    const state = await asPerson(tenant, async (client) => {
      const r = await callBulkBook(client, tenant, { txIds: [fee], existing: voucher, actorType: 'user', actorLabel: 'anna@example.se' })
      expect(r).toMatchObject({ ok: true, mode: 'link_existing', linked_tx_count: 1 })
      await client.query('RESET ROLE')
      return linkState(client, voucher, [fee])
    })

    expect(state.links).toEqual([{ transaction_id: fee, allocated_amount: -9, link_basis: 'user_confirmed', link_evidence: null }])
    expect(state.rows).toEqual([{ id: fee, journal_entry_id: voucher, link_basis: 'user_confirmed', link_evidence: null }])
  })

  it('a person booking a samlingsverifikat: user_created on links and pointer, the pinned underlag system_derived', async () => {
    const tenant = await seedTenant()
    const fee = await feeRow(tenant, -12)
    const doc = await pinDocument(tenant, fee)

    const result = await asPerson(tenant, async (client) => {
      const r = await callBulkBook(client, tenant, { txIds: [fee], newEntry: newFeeEntry(12) })
      await client.query('RESET ROLE')
      const { rows: docs } = await client.query(
        `SELECT journal_entry_id, link_basis, link_evidence FROM public.document_attachments WHERE id = $1`,
        [doc],
      )
      return { r, state: await linkState(client, r.journal_entry_id!, [fee]), entry: await entryState(client, r.journal_entry_id!), doc: docs[0] }
    })

    expect(result.r).toMatchObject({ ok: true, mode: 'create_new', voucher_series: 'A', voucher_number: 1, linked_tx_count: 1, docs_linked: 1 })
    expect(result.state.links).toEqual([{ transaction_id: fee, allocated_amount: -12, link_basis: 'user_created', link_evidence: null }])
    expect(result.state.rows).toEqual([{ id: fee, journal_entry_id: result.r.journal_entry_id, link_basis: 'user_created', link_evidence: null }])
    expect(result.doc).toEqual({
      journal_entry_id: result.r.journal_entry_id,
      link_basis: 'system_derived',
      link_evidence: { rule_id: 'bank_row_document_pin' },
    })
    expect(result.entry.entry).toMatchObject({ status: 'posted', voucher_series: 'A', voucher_number: 1 })
  })

  it('an API key booking through the v1 door: client_asserted', async () => {
    const tenant = await seedTenant()
    const fees = [await feeRow(tenant, -5), await feeRow(tenant, -6)]

    const result = await asService(async (client) => {
      const r = await callBulkBook(client, tenant, { txIds: fees, newEntry: newFeeEntry(11), actorType: 'api_key', actorLabel: 'Bokföringsagent' })
      return { r, state: await linkState(client, r.journal_entry_id!, fees), entry: await entryState(client, r.journal_entry_id!) }
    })

    expect(result.r).toMatchObject({ ok: true, mode: 'create_new', voucher_number: 1, linked_tx_count: 2 })
    expect(result.state.links.map((l) => l.link_basis)).toEqual(['client_asserted', 'client_asserted'])
    expect(result.entry.entry).toMatchObject({ committed_actor_type: 'api_key', committed_actor_label: 'Bokföringsagent' })
  })

  it('an MCP connector linking a row: client_asserted on the link row and the pointer', async () => {
    const tenant = await seedTenant()
    const fee = await feeRow(tenant, -7)
    const voucher = await feeVoucher(tenant, 7)

    const state = await asService(async (client) => {
      const r = await callBulkBook(client, tenant, { txIds: [fee], existing: voucher, actorType: 'mcp_oauth', actorLabel: 'Claude' })
      expect(r).toMatchObject({ ok: true, mode: 'link_existing' })
      return linkState(client, voucher, [fee])
    })

    expect(state.links.map((l) => l.link_basis)).toEqual(['client_asserted'])
    expect(state.rows.map((r) => r.link_basis)).toEqual(['client_asserted'])
  })

  it('cron: system_derived', async () => {
    const tenant = await seedTenant()
    const fee = await feeRow(tenant, -8)

    const state = await asService(async (client) => {
      const r = await callBulkBook(client, tenant, { txIds: [fee], newEntry: newFeeEntry(8), actorType: 'cron', actorLabel: 'cron.test' })
      expect(r).toMatchObject({ ok: true, mode: 'create_new' })
      return linkState(client, r.journal_entry_id!, [fee])
    })

    expect(state.links.map((l) => l.link_basis)).toEqual(['system_derived'])
    expect(state.rows.map((r) => r.link_basis)).toEqual(['system_derived'])
  })

  it('reads the actor an enclosing SQL caller set when none is passed', async () => {
    const tenant = await seedTenant()
    const fee = await feeRow(tenant, -4)
    const voucher = await feeVoucher(tenant, 4)

    const state = await asService(async (client) => {
      const r = await callBulkBook(client, tenant, { txIds: [fee], existing: voucher, setting: 'service_account' })
      expect(r).toMatchObject({ ok: true })
      return linkState(client, voucher, [fee])
    })

    expect(state.links.map((l) => l.link_basis)).toEqual(['client_asserted'])
  })

  it('with the actor missing or garbage, books exactly as before: voucher numbers, lines, balance, links', async () => {
    const tenant = await seedTenant()
    const first = [await feeRow(tenant, -3.25), await feeRow(tenant, -4.5)]
    const second = await feeRow(tenant, -10)
    const linkRows = [await feeRow(tenant, -2, '2026-09-03'), await feeRow(tenant, -3, '2026-10-02')]
    const oneMore = await feeRow(tenant, -6, '2026-09-20')
    const voucher = await feeVoucher(tenant, 5)
    const voucher2 = await feeVoucher(tenant, 6, 2)

    const outcome = await asPerson(tenant, async (client) => {
      // No actor and no setting: the plain session call.
      const a = await callBulkBook(client, tenant, { txIds: first, newEntry: newFeeEntry(7.75) })
      const b = await callBulkBook(client, tenant, { txIds: [second], newEntry: newFeeEntry(10) })
      // A garbage setting left by an enclosing caller, and a garbage actor
      // passed in: neither is an actor the helper knows, the door stands.
      const c = await callBulkBook(client, tenant, { txIds: linkRows, existing: voucher, setting: "x'; DROP TABLE y; --" })
      const d = await callBulkBook(client, tenant, { txIds: [oneMore], existing: voucher2, setting: '', actorType: 'not-an-actor' })
      await client.query('RESET ROLE')
      return {
        a,
        b,
        c,
        d,
        entryA: await entryState(client, a.journal_entry_id!),
        entryB: await entryState(client, b.journal_entry_id!),
        linksA: await linkState(client, a.journal_entry_id!, first),
        linksB: await linkState(client, b.journal_entry_id!, [second]),
        linksC: await linkState(client, voucher, linkRows),
        linksD: await linkState(client, voucher2, [oneMore]),
      }
    })

    expect(outcome.a).toMatchObject({ ok: true, mode: 'create_new', voucher_series: 'A', voucher_number: 1, linked_tx_count: 2, tx_sum: -7.75, docs_linked: 0 })
    expect(outcome.b).toMatchObject({ ok: true, mode: 'create_new', voucher_series: 'A', voucher_number: 2, linked_tx_count: 1, tx_sum: -10 })
    expect(outcome.c).toMatchObject({ ok: true, mode: 'link_existing', voucher_series: 'B', voucher_number: 1, linked_tx_count: 2, tx_sum: -5 })
    expect(outcome.d).toMatchObject({ ok: true, mode: 'link_existing', linked_tx_count: 1, tx_sum: -6 })

    for (const [state, total] of [[outcome.entryA, 7.75], [outcome.entryB, 10]] as const) {
      expect(state.entry).toMatchObject({ status: 'posted', committed_actor_type: null, committed_actor_label: null })
      expect(state.lines).toEqual([
        { account_number: '6570', debit: total, credit: 0 },
        { account_number: '1686', debit: 0, credit: total },
      ])
      const debit = state.lines.reduce((s, l) => s + l.debit, 0)
      const credit = state.lines.reduce((s, l) => s + l.credit, 0)
      expect(debit).toBe(credit)
    }

    expect(outcome.linksA.links.map((l) => [l.allocated_amount, l.link_basis]).sort()).toEqual([
      [-3.25, 'user_created'],
      [-4.5, 'user_created'],
    ])
    expect(outcome.linksB.links).toEqual([{ transaction_id: second, allocated_amount: -10, link_basis: 'user_created', link_evidence: null }])
    expect(outcome.linksB.rows[0]).toMatchObject({ journal_entry_id: outcome.b.journal_entry_id, link_basis: 'user_created' })
    expect(outcome.linksC.links.map((l) => [l.allocated_amount, l.link_basis]).sort()).toEqual([
      [-2, 'user_confirmed'],
      [-3, 'user_confirmed'],
    ])
    expect(outcome.linksD.links.map((l) => l.link_basis)).toEqual(['user_confirmed'])
    expect(outcome.linksD.rows[0]).toMatchObject({ journal_entry_id: voucher2, link_basis: 'user_confirmed' })
  })

  it('a garbage setting still stops a new verifikat where it always did: the audit row of the draft, before any link', async () => {
    // write_audit_log copies gnubok.actor_type onto the audit row of the
    // journal_entries insert, and audit_log_actor_type_check refuses an
    // unknown value. That refusal predates the link basis and comes first;
    // the helper is never reached and nothing is written.
    const tenant = await seedTenant()
    const fee = await feeRow(tenant, -9)

    const outcome = await asPerson(tenant, async (client) => {
      await client.query('SAVEPOINT before_call')
      const error = await callBulkBook(client, tenant, { txIds: [fee], newEntry: newFeeEntry(9), setting: 'garbage' }).then(
        () => null,
        (err: Error) => err.message,
      )
      await client.query('ROLLBACK TO SAVEPOINT before_call')
      await client.query('RESET ROLE')
      const { rows } = await client.query(`SELECT count(*)::int AS n FROM public.transaction_voucher_links WHERE transaction_id = $1`, [fee])
      return { error, links: rows[0].n }
    })

    expect(outcome.error).toMatch(/audit_log_actor_type_check/)
    expect(outcome.links).toBe(0)
  })

  it('keeps its signature, SECURITY DEFINER, search_path, grants and comment', async () => {
    await expectFunctionUnchanged('bulk_book_transactions', {
      sig: 'bulk_book_transactions(uuid[],uuid,jsonb,uuid,uuid,text,text,text,uuid[],text)',
      definer: true,
      config: ['search_path=public'],
      grantees: ['authenticated', 'postgres', 'service_role'],
      comment: 'Bulk-book N SEK bank transactions',
    })
  })
})

async function expectFunctionUnchanged(
  name: string,
  expected: { sig: string; definer: boolean; config: string[]; grantees: string[]; comment: string | null },
): Promise<void> {
  const client = await getClient()
  try {
    const { rows } = await client.query(
      `SELECT p.oid::regprocedure::text AS sig, p.prosecdef AS definer, p.proconfig AS config,
              ARRAY(SELECT DISTINCT a.grantee::regrole::text FROM aclexplode(p.proacl) a
                     WHERE a.privilege_type = 'EXECUTE' ORDER BY 1) AS grantees,
              obj_description(p.oid, 'pg_proc') AS comment
         FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = $1`,
      [name],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ sig: expected.sig, definer: expected.definer, config: expected.config, grantees: expected.grantees })
    if (expected.comment === null) expect(rows[0].comment).toBeNull()
    else expect(rows[0].comment).toContain(expected.comment)
  } finally {
    client.release()
  }
}

// ---------------------------------------------------------------------------
// match_batch_allocate, link_invoice_to_voucher, create_expense_payout_batch
// ---------------------------------------------------------------------------

let seq = 0
const nextSeq = () => (Date.now() % 1_000_000) * 1000 + seq++

async function sekSupplierInvoice(owner: { userId: string; companyId: string }, total: number): Promise<string> {
  const supplierId = randomUUID()
  await getPool().query(
    `INSERT INTO public.suppliers
       (id, user_id, company_id, name, supplier_type, country, default_payment_terms, default_currency)
     VALUES ($1, $2, $3, 'Leverantör AB', 'swedish_business', 'SE', 30, 'SEK')`,
    [supplierId, owner.userId, owner.companyId],
  )
  const id = randomUUID()
  const arrival = nextSeq()
  await getPool().query(
    `INSERT INTO public.supplier_invoices
       (id, user_id, company_id, supplier_id, arrival_number, supplier_invoice_number,
        invoice_date, due_date, received_date, status, currency, exchange_rate,
        subtotal, vat_amount, total, paid_amount, remaining_amount,
        vat_treatment, reverse_charge, is_credit_note)
     VALUES ($1, $2, $3, $4, $5, $6, '2026-04-01', '2026-05-01', '2026-04-01', 'approved', 'SEK', NULL,
             $7, 0, $7, 0, $7, 'standard_25', false, false)`,
    [id, owner.userId, owner.companyId, supplierId, arrival, `LF-${arrival}`, total],
  )
  return id
}

async function sekCustomerInvoice(owner: { userId: string; companyId: string }, total: number): Promise<string> {
  const customerId = randomUUID()
  await getPool().query(
    `INSERT INTO public.customers (id, user_id, company_id, name, customer_type)
     VALUES ($1, $2, $3, 'Kund AB', 'swedish_business')`,
    [customerId, owner.userId, owner.companyId],
  )
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.invoices
       (id, user_id, company_id, customer_id, invoice_number, invoice_date, due_date,
        currency, exchange_rate, subtotal, vat_amount, total, total_sek,
        vat_treatment, vat_rate, status, paid_amount, remaining_amount)
     VALUES ($1, $2, $3, $4, $5, '2026-04-01', '2026-05-01',
             'SEK', NULL, $6, 0, $6, $6, 'standard_25', 25, 'sent', 0, $6)`,
    [id, owner.userId, owner.companyId, customerId, `F-${nextSeq()}`, total],
  )
  return id
}

async function bankRow(owner: { userId: string; companyId: string }, amount: number, date = '2026-06-05'): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.transactions (id, user_id, company_id, date, description, amount, currency, category)
     VALUES ($1, $2, $3, $4, 'Bank transfer', $5, 'SEK', 'uncategorized')`,
    [id, owner.userId, owner.companyId, date, amount],
  )
  return id
}

async function txLink(client: PoolClient, txId: string) {
  const { rows } = await client.query(
    `SELECT journal_entry_id, link_basis, link_evidence FROM public.transactions WHERE id = $1`,
    [txId],
  )
  return rows[0]
}

async function balanced(client: PoolClient, journalEntryId: string) {
  const { rows } = await client.query(
    `SELECT je.status, je.voucher_number, je.committed_actor_type,
            SUM(l.debit_amount)::float8 AS debit, SUM(l.credit_amount)::float8 AS credit
       FROM public.journal_entries je JOIN public.journal_entry_lines l ON l.journal_entry_id = je.id
      WHERE je.id = $1 GROUP BY je.id`,
    [journalEntryId],
  )
  return rows[0]
}

interface MatchResult {
  ok: boolean
  code?: string
  journal_entry_id?: string
  voucher_number?: number
  allocations?: Array<{ kind: string; payment_id: string; status: string; amount: number }>
}

async function callMatchBatch(
  client: PoolClient,
  p: { txId: string; allocations: unknown[]; companyId: string; userId: string; actorType?: string | null },
): Promise<MatchResult> {
  const { rows } = await client.query<{ r: MatchResult }>(
    `SELECT public.match_batch_allocate(
       p_tx_id => $1, p_allocations => $2::jsonb, p_company_id => $3, p_user_id => $4,
       p_actor_type => $5, p_actor_label => NULL) AS r`,
    [p.txId, JSON.stringify(p.allocations), p.companyId, p.userId, p.actorType ?? null],
  )
  return rows[0]!.r
}

describe('match_batch_allocate records the link basis', () => {
  it('a person allocating a bank row across a customer and a supplier invoice: user_confirmed everywhere', async () => {
    // Income against one invoice and an outgoing refund are different
    // directions; allocate one income row across two customer invoices.
    const owner = await seedCompany()
    const invoices = [await sekCustomerInvoice(owner, 600), await sekCustomerInvoice(owner, 400)]
    const tx = await bankRow(owner, 1000)

    const outcome = await withUserContext(owner.userId, async (client) => {
      const r = await callMatchBatch(client, {
        txId: tx,
        allocations: [
          { kind: 'customer_invoice', invoice_id: invoices[0], amount: 600 },
          { kind: 'customer_invoice', invoice_id: invoices[1], amount: 400 },
        ],
        companyId: owner.companyId,
        userId: owner.userId,
        actorType: 'user',
      })
      await client.query('RESET ROLE')
      const { rows: payments } = await client.query(
        `SELECT amount::float8 AS amount, journal_entry_id, transaction_id, link_basis, link_evidence
           FROM public.invoice_payments WHERE invoice_id = ANY($1::uuid[]) ORDER BY amount DESC`,
        [invoices],
      )
      return { r, payments, tx: await txLink(client, tx), entry: await balanced(client, r.journal_entry_id!) }
    })

    expect(outcome.r).toMatchObject({ ok: true, voucher_number: 1 })
    expect(outcome.payments).toEqual([
      { amount: 600, journal_entry_id: outcome.r.journal_entry_id, transaction_id: tx, link_basis: 'user_confirmed', link_evidence: null },
      { amount: 400, journal_entry_id: outcome.r.journal_entry_id, transaction_id: tx, link_basis: 'user_confirmed', link_evidence: null },
    ])
    expect(outcome.tx).toEqual({ journal_entry_id: outcome.r.journal_entry_id, link_basis: 'user_confirmed', link_evidence: null })
    expect(outcome.entry).toMatchObject({ status: 'posted', voucher_number: 1, committed_actor_type: 'user', debit: 1000, credit: 1000 })
  })

  it('an API key: client_asserted on the supplier payment row and the pointer', async () => {
    const owner = await seedCompany()
    const si = await sekSupplierInvoice(owner, 2000)
    const tx = await bankRow(owner, -2000)

    const outcome = await runAsServiceRole(async (client) => {
      const r = await callMatchBatch(client, {
        txId: tx,
        allocations: [{ kind: 'supplier_invoice', supplier_invoice_id: si, amount: 2000 }],
        companyId: owner.companyId,
        userId: owner.userId,
        actorType: 'api_key',
      })
      const { rows } = await client.query(
        `SELECT link_basis FROM public.supplier_invoice_payments WHERE supplier_invoice_id = $1`,
        [si],
      )
      return { r, payments: rows, tx: await txLink(client, tx) }
    })

    expect(outcome.r).toMatchObject({ ok: true })
    expect(outcome.payments).toEqual([{ link_basis: 'client_asserted' }])
    expect(outcome.tx.link_basis).toBe('client_asserted')
  })

  it('cron: system_derived; no actor at all: user_confirmed, booked as before', async () => {
    const owner = await seedCompany()
    const first = await sekSupplierInvoice(owner, 300)
    const second = await sekSupplierInvoice(owner, 700)
    const txCron = await bankRow(owner, -300)
    const txNone = await bankRow(owner, -700)

    const outcome = await runAsServiceRole(async (client) => {
      const cron = await callMatchBatch(client, {
        txId: txCron,
        allocations: [{ kind: 'supplier_invoice', supplier_invoice_id: first, amount: 300 }],
        companyId: owner.companyId,
        userId: owner.userId,
        actorType: 'cron',
      })
      const none = await callMatchBatch(client, {
        txId: txNone,
        allocations: [{ kind: 'supplier_invoice', supplier_invoice_id: second, amount: 700 }],
        companyId: owner.companyId,
        userId: owner.userId,
      })
      const { rows } = await client.query(
        `SELECT supplier_invoice_id, amount::float8 AS amount, link_basis
           FROM public.supplier_invoice_payments WHERE supplier_invoice_id = ANY($1::uuid[]) ORDER BY amount`,
        [[first, second]],
      )
      return {
        cron,
        none,
        payments: rows,
        txCron: await txLink(client, txCron),
        txNone: await txLink(client, txNone),
        entryNone: await balanced(client, none.journal_entry_id!),
      }
    })

    expect(outcome.cron).toMatchObject({ ok: true, voucher_number: 1 })
    expect(outcome.none).toMatchObject({ ok: true, voucher_number: 2 })
    expect(outcome.payments).toEqual([
      { supplier_invoice_id: first, amount: 300, link_basis: 'system_derived' },
      { supplier_invoice_id: second, amount: 700, link_basis: 'user_confirmed' },
    ])
    expect(outcome.txCron.link_basis).toBe('system_derived')
    expect(outcome.txNone.link_basis).toBe('user_confirmed')
    expect(outcome.entryNone).toMatchObject({ status: 'posted', committed_actor_type: null, debit: 700, credit: 700 })
  })

  it('keeps its signature, SECURITY DEFINER, search_path, grants and comment', async () => {
    await expectFunctionUnchanged('match_batch_allocate', {
      sig: 'match_batch_allocate(uuid,jsonb,uuid,uuid,text,text,jsonb,jsonb,uuid[],text)',
      definer: true,
      config: ['search_path=public'],
      grantees: ['authenticated', 'postgres', 'service_role'],
      comment: 'samlingsverifikat',
    })
  })
})

describe('link_invoice_to_voucher records the link basis', () => {
  async function paidVoucher(owner: { userId: string; companyId: string; fiscalPeriodId: string }, amount: number, voucherNumber: number) {
    return insertPostedJournalEntry({
      ...owner,
      entryDate: '2026-05-05',
      voucherSeries: 'B',
      voucherNumber,
      lines: [
        { accountNumber: '1930', debitAmount: amount, creditAmount: 0 },
        { accountNumber: '1510', debitAmount: 0, creditAmount: amount },
      ],
    })
  }

  async function paymentRow(invoiceId: string) {
    const { rows } = await getPool().query(
      `SELECT amount::float8 AS amount, journal_entry_id, link_basis, link_evidence FROM public.invoice_payments WHERE invoice_id = $1`,
      [invoiceId],
    )
    return rows
  }

  it('a person, an API key, cron and the five-argument call each record their basis; the payment is as before', async () => {
    const owner = await seedCompany()
    const invoices = await Promise.all([1000, 1100, 1200, 1300].map((t) => sekCustomerInvoice(owner, t)))
    const vouchers = [
      await paidVoucher(owner, 1000, 1),
      await paidVoucher(owner, 1100, 2),
      await paidVoucher(owner, 1200, 3),
      await paidVoucher(owner, 1300, 4),
    ]

    const person = await withUserContext(owner.userId, async (client) => {
      const { rows } = await client.query<{ r: { ok: boolean; invoice_status: string; payment_amount: number } }>(
        `SELECT public.link_invoice_to_voucher(
           p_invoice_id => $1, p_journal_entry_id => $2, p_user_id => $3, p_company_id => $4,
           p_actor_type => 'user', p_actor_label => 'anna@example.se') AS r`,
        [invoices[0], vouchers[0], owner.userId, owner.companyId],
      )
      await client.query('RESET ROLE')
      const { rows: payments } = await client.query(
        `SELECT amount::float8 AS amount, journal_entry_id, link_basis, link_evidence FROM public.invoice_payments WHERE invoice_id = $1`,
        [invoices[0]],
      )
      return { r: rows[0]!.r, payments }
    })
    expect(person.r).toMatchObject({ ok: true, invoice_status: 'paid', payment_amount: 1000 })
    expect(person.payments).toEqual([{ amount: 1000, journal_entry_id: vouchers[0], link_basis: 'user_confirmed', link_evidence: null }])

    await runAsServiceRole(async (client) => {
      const machine = await client.query<{ r: { ok: boolean } }>(
        `SELECT public.link_invoice_to_voucher(
           p_invoice_id => $1, p_journal_entry_id => $2, p_user_id => $3, p_company_id => $4,
           p_actor_type => 'api_key', p_actor_label => 'Bokföringsagent') AS r`,
        [invoices[1], vouchers[1], owner.userId, owner.companyId],
      )
      expect(machine.rows[0]!.r.ok).toBe(true)
      const cron = await client.query<{ r: { ok: boolean } }>(
        `SELECT public.link_invoice_to_voucher(
           p_invoice_id => $1, p_journal_entry_id => $2, p_user_id => $3, p_company_id => $4,
           p_actor_type => 'cron', p_actor_label => 'cron.test') AS r`,
        [invoices[2], vouchers[2], owner.userId, owner.companyId],
      )
      expect(cron.rows[0]!.r.ok).toBe(true)
      // The five-argument call an older deploy sends: no actor anywhere.
      const positional = await client.query<{ r: { ok: boolean; invoice_status: string } }>(
        `SELECT public.link_invoice_to_voucher($1, $2, $3, $4, NULL) AS r`,
        [invoices[3], vouchers[3], owner.userId, owner.companyId],
      )
      expect(positional.rows[0]!.r).toMatchObject({ ok: true, invoice_status: 'paid' })
    })

    expect(await paymentRow(invoices[1]!)).toEqual([{ amount: 1100, journal_entry_id: vouchers[1], link_basis: 'client_asserted', link_evidence: null }])
    expect(await paymentRow(invoices[2]!)).toEqual([{ amount: 1200, journal_entry_id: vouchers[2], link_basis: 'system_derived', link_evidence: null }])
    expect(await paymentRow(invoices[3]!)).toEqual([{ amount: 1300, journal_entry_id: vouchers[3], link_basis: 'user_confirmed', link_evidence: null }])
  })

  it('keeps its signature, SECURITY DEFINER, search_path, grants and comment', async () => {
    await expectFunctionUnchanged('link_invoice_to_voucher', {
      sig: 'link_invoice_to_voucher(uuid,uuid,uuid,uuid,text,numeric,text,text,uuid[],text)',
      definer: true,
      config: ['search_path=public'],
      grantees: ['authenticated', 'postgres', 'service_role'],
      comment: 'customer invoice as its payment',
    })
  })
})

describe('create_expense_payout_batch records the link basis of the bank row', () => {
  async function payoutTenant() {
    const owner = await seedCompany()
    await getPool().query(
      `INSERT INTO public.chart_of_accounts
         (user_id, company_id, account_number, account_name, account_class, account_type, normal_balance, is_active)
       VALUES ($1, $2, '1930', 'Företagskonto', 1, 'asset', 'debit', true),
              ($1, $2, '2893', 'Skuld till aktieägare', 2, 'liability', 'credit', true)
       ON CONFLICT DO NOTHING`,
      [owner.userId, owner.companyId],
    )
    return owner
  }

  async function claim(owner: { userId: string; companyId: string }, amount: number): Promise<string> {
    const id = randomUUID()
    await getPool().query(
      `INSERT INTO public.expense_claims
         (id, company_id, user_id, claimant_name, description, expense_date, amount_sek, vat_sek, expense_account, liability_account, status)
       VALUES ($1, $2, $3, 'Ägare', 'Kvitto', '2026-08-25', $4, 0, '5410', '2893', 'registered')`,
      [id, owner.companyId, owner.userId, amount],
    )
    return id
  }

  interface PayoutResult {
    ok: boolean
    code?: string
    journal_entry_id?: string
    voucher_number?: number
    transaction_id?: string | null
  }

  async function payout(
    client: PoolClient,
    owner: { userId: string; companyId: string },
    p: { claimId: string; txId: string | null; actorType?: string | null },
  ): Promise<PayoutResult> {
    const { rows } = await client.query<{ r: PayoutResult }>(
      `SELECT public.create_expense_payout_batch(
         p_company_id => $1, p_claim_ids => ARRAY[$2::uuid], p_payout_date => '2026-08-31'::date,
         p_cash_account => '1930', p_user_id => $3, p_transaction_id => $4,
         p_actor_type => $5, p_actor_label => NULL) AS r`,
      [owner.companyId, p.claimId, owner.userId, p.txId, p.actorType ?? null],
    )
    return rows[0]!.r
  }

  it('a person matching the payout to its bank row: user_confirmed on the pointer, booked as before', async () => {
    const owner = await payoutTenant()
    const claimId = await claim(owner, 500)
    const tx = await bankRow(owner, -500, '2026-08-31')

    const outcome = await withUserContext(owner.userId, async (client) => {
      const r = await payout(client, owner, { claimId, txId: tx })
      await client.query('RESET ROLE')
      return { r, tx: await txLink(client, tx), entry: await balanced(client, r.journal_entry_id!) }
    })

    expect(outcome.r).toMatchObject({ ok: true, voucher_number: 1, transaction_id: tx })
    expect(outcome.tx).toEqual({ journal_entry_id: outcome.r.journal_entry_id, link_basis: 'user_confirmed', link_evidence: null })
    expect(outcome.entry).toMatchObject({ status: 'posted', voucher_number: 1, committed_actor_type: null, debit: 500, credit: 500 })
  })

  it('an MCP connector: client_asserted; cron: system_derived; no bank row: nothing linked', async () => {
    const owner = await payoutTenant()
    const claims = [await claim(owner, 100), await claim(owner, 200), await claim(owner, 300)]
    const txMcp = await bankRow(owner, -100, '2026-08-31')
    const txCron = await bankRow(owner, -200, '2026-08-31')

    const outcome = await runAsServiceRole(async (client) => {
      const mcp = await payout(client, owner, { claimId: claims[0]!, txId: txMcp, actorType: 'mcp_oauth' })
      const cron = await payout(client, owner, { claimId: claims[1]!, txId: txCron, actorType: 'cron' })
      const plain = await payout(client, owner, { claimId: claims[2]!, txId: null, actorType: 'api_key' })
      return { mcp, cron, plain, txMcp: await txLink(client, txMcp), txCron: await txLink(client, txCron) }
    })

    expect([outcome.mcp.ok, outcome.cron.ok, outcome.plain.ok]).toEqual([true, true, true])
    expect(outcome.plain.transaction_id).toBeNull()
    expect(outcome.txMcp.link_basis).toBe('client_asserted')
    expect(outcome.txCron.link_basis).toBe('system_derived')
  })

  it('keeps its signature, SECURITY DEFINER, search_path, grants and comment', async () => {
    await expectFunctionUnchanged('create_expense_payout_batch', {
      sig: 'create_expense_payout_batch(uuid,uuid[],date,text,text,uuid,uuid,text,text,uuid[],text)',
      definer: true,
      config: ['search_path=public'],
      grantees: ['authenticated', 'postgres', 'service_role'],
      comment: 'reimbursement transfer',
    })
  })
})

// ---------------------------------------------------------------------------
// relink_stranded_transactions, create_document_version
// ---------------------------------------------------------------------------

describe('relink_stranded_transactions records the rule it relinked by', () => {
  /** A posted verifikat with one 1930 line, and a stranded bank row of the same amount and date. */
  async function strandedPair(owner: { userId: string; companyId: string; fiscalPeriodId: string }, amount: number, voucherNumber: number) {
    const entry = await insertPostedJournalEntry({
      ...owner,
      entryDate: '2026-06-01',
      voucherNumber,
      sourceType: 'import',
      // Money out credits 1930, money in debits it: the line carries the row's sign.
      lines:
        amount < 0
          ? [
              { accountNumber: '5010', debitAmount: -amount, creditAmount: 0 },
              { accountNumber: '1930', debitAmount: 0, creditAmount: -amount },
            ]
          : [
              { accountNumber: '1930', debitAmount: amount, creditAmount: 0 },
              { accountNumber: '3001', debitAmount: 0, creditAmount: amount },
            ],
    })
    const row = await insertTransaction({ ...owner, amount, date: '2026-06-01' })
    await getPool().query(
      `UPDATE public.transactions SET is_business = true, category = 'expense_office', reconciliation_method = 'manual' WHERE id = $1`,
      [row],
    )
    return { entry, row }
  }

  const actor = JSON.stringify({ type: 'user', id: randomUUID(), label: 'pg-real' })

  it('rule_amount_date with rule_id auto_exact_unique, whoever starts the run; a dry run writes nothing', async () => {
    const owner = await seedCompany()
    const { entry, row } = await strandedPair(owner, -250, 1001)

    await runAsServiceRole((c) => c.query(`SELECT * FROM public.relink_stranded_transactions($1, true, false, NULL, NULL)`, [owner.companyId]))
    const before = await getPool().query(`SELECT journal_entry_id, link_basis FROM public.transactions WHERE id = $1`, [row])
    expect(before.rows[0]).toEqual({ journal_entry_id: null, link_basis: null })

    // A cron actor in the setting does not turn a rule into anything else.
    await runAsServiceRole(async (c) => {
      await c.query(`SELECT set_config('gnubok.actor_type', 'cron', true)`)
      await c.query(`SELECT * FROM public.relink_stranded_transactions($1, false, false, $2::jsonb, NULL)`, [owner.companyId, actor])
    })
    const { rows } = await getPool().query(
      `SELECT journal_entry_id, reconciliation_method, link_basis, link_evidence FROM public.transactions WHERE id = $1`,
      [row],
    )
    expect(rows[0]).toEqual({
      journal_entry_id: entry,
      reconciliation_method: 'auto_exact',
      link_basis: 'rule_amount_date',
      link_evidence: { rule_id: 'auto_exact_unique' },
    })
  })

  it('a balanced group, when asked: rule_id auto_exact_balanced_group on each row', async () => {
    const owner = await seedCompany()
    const a = await strandedPair(owner, 300, 2001)
    const b = await strandedPair(owner, 300, 2002)

    await runAsServiceRole((c) =>
      c.query(`SELECT * FROM public.relink_stranded_transactions($1, false, true, $2::jsonb, NULL)`, [owner.companyId, actor]),
    )
    const { rows } = await getPool().query(
      `SELECT link_basis, link_evidence FROM public.transactions WHERE id = ANY($1::uuid[]) AND journal_entry_id IS NOT NULL`,
      [[a.row, b.row]],
    )
    expect(rows).toEqual([
      { link_basis: 'rule_amount_date', link_evidence: { rule_id: 'auto_exact_balanced_group' } },
      { link_basis: 'rule_amount_date', link_evidence: { rule_id: 'auto_exact_balanced_group' } },
    ])
  })

  it('keeps its signature, SECURITY INVOKER, search_path, grants and comment', async () => {
    await expectFunctionUnchanged('relink_stranded_transactions', {
      sig: 'relink_stranded_transactions(uuid,boolean,boolean,jsonb,uuid)',
      definer: false,
      config: ['search_path=pg_catalog, public'],
      grantees: ['postgres', 'service_role'],
      comment: 'Issue #2835',
    })
  })
})

describe('create_document_version carries the link basis of the version it replaces', () => {
  async function linkedDocument(
    owner: { userId: string; companyId: string; fiscalPeriodId: string },
    basis: { link_basis: string | null; link_evidence: unknown },
    linked: boolean,
  ): Promise<string> {
    const entry = linked ? await insertPostedJournalEntry({ ...owner, voucherNumber: 1 }) : null
    const id = randomUUID()
    await getPool().query(
      `INSERT INTO public.document_attachments
         (id, user_id, company_id, file_name, mime_type, file_size_bytes, storage_path, sha256_hash,
          upload_source, journal_entry_id, link_basis, link_evidence)
       VALUES ($1, $2, $3, 'kvitto.pdf', 'application/pdf', 100, $4, repeat('a', 64), 'file_upload', $5, $6, $7::jsonb)`,
      [
        id,
        owner.userId,
        owner.companyId,
        `documents/${owner.companyId}/${id}.pdf`,
        entry,
        basis.link_basis,
        basis.link_evidence === null ? null : JSON.stringify(basis.link_evidence),
      ],
    )
    return id
  }

  async function newVersion(owner: { userId: string; companyId: string }, docId: string) {
    return withUserContext(owner.userId, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `SELECT public.create_document_version($1::uuid, $2::uuid, $3::text, $4::text, $5::bigint, $6::text, $7::text) AS id`,
        [owner.userId, docId, `documents/${owner.companyId}/v2.pdf`, 'kvitto-v2.pdf', 2048, 'application/pdf', 'c'.repeat(64)],
      )
      await client.query('RESET ROLE')
      const { rows: versions } = await client.query(
        `SELECT id, version, is_current_version, journal_entry_id, link_basis, link_evidence
           FROM public.document_attachments WHERE id = ANY($1::uuid[]) ORDER BY version`,
        [[docId, rows[0]!.id]],
      )
      return versions
    })
  }

  it('the new version of an underlag on a posted verifikat keeps its basis and evidence', async () => {
    const owner = await seedCompany()
    const receipt = randomUUID()
    const doc = await linkedDocument(owner, { link_basis: 'user_confirmed', link_evidence: { receipt_id: receipt } }, true)

    const versions = await newVersion(owner, doc)

    expect(versions).toHaveLength(2)
    expect(versions[0]).toMatchObject({ id: doc, version: 1, is_current_version: false, link_basis: 'user_confirmed' })
    expect(versions[1]).toMatchObject({
      version: 2,
      is_current_version: true,
      journal_entry_id: versions[0].journal_entry_id,
      link_basis: 'user_confirmed',
      link_evidence: { receipt_id: receipt },
    })
  })

  it('no basis recorded on the old version: none on the new one', async () => {
    const owner = await seedCompany()
    const doc = await linkedDocument(owner, { link_basis: null, link_evidence: null }, false)

    const versions = await newVersion(owner, doc)

    expect(versions[1]).toMatchObject({ version: 2, journal_entry_id: null, link_basis: null, link_evidence: null })
  })

  it('keeps its signature, SECURITY DEFINER, search_path and grants', async () => {
    await expectFunctionUnchanged('create_document_version', {
      sig: 'create_document_version(uuid,uuid,text,text,bigint,text,text)',
      definer: true,
      config: ['search_path=public'],
      grantees: ['authenticated', 'postgres', 'service_role'],
      comment: null,
    })
  })
})

describe('a garbage actor changes nothing the bookings did before', () => {
  it('link_invoice_to_voucher with a garbage setting or a garbage actor: links as before, user_confirmed', async () => {
    // No audited table and no actor CHECK on this path (a SEK invoice posts
    // no kursdifferens verifikat), so the garbage reaches only the helper,
    // which keeps the door.
    const owner = await seedCompany()
    const invoices = [await sekCustomerInvoice(owner, 500), await sekCustomerInvoice(owner, 700)]
    const vouchers = [
      await insertPostedJournalEntry({
        ...owner,
        entryDate: '2026-05-05',
        voucherSeries: 'B',
        voucherNumber: 11,
        lines: [
          { accountNumber: '1930', debitAmount: 500, creditAmount: 0 },
          { accountNumber: '1510', debitAmount: 0, creditAmount: 500 },
        ],
      }),
      await insertPostedJournalEntry({
        ...owner,
        entryDate: '2026-05-05',
        voucherSeries: 'B',
        voucherNumber: 12,
        lines: [
          { accountNumber: '1930', debitAmount: 700, creditAmount: 0 },
          { accountNumber: '1510', debitAmount: 0, creditAmount: 700 },
        ],
      }),
    ]

    const results = await withUserContext(owner.userId, async (client) => {
      await client.query(`SELECT set_config('gnubok.actor_type', 'garbage', true)`)
      const a = await client.query<{ r: { ok: boolean; invoice_status: string; payment_amount: number } }>(
        `SELECT public.link_invoice_to_voucher($1, $2, $3, $4, NULL) AS r`,
        [invoices[0], vouchers[0], owner.userId, owner.companyId],
      )
      await client.query(`SELECT set_config('gnubok.actor_type', '', true)`)
      const b = await client.query<{ r: { ok: boolean; invoice_status: string; payment_amount: number } }>(
        `SELECT public.link_invoice_to_voucher(
           p_invoice_id => $1, p_journal_entry_id => $2, p_user_id => $3, p_company_id => $4,
           p_actor_type => 'not-an-actor') AS r`,
        [invoices[1], vouchers[1], owner.userId, owner.companyId],
      )
      await client.query('RESET ROLE')
      const { rows } = await client.query(
        `SELECT invoice_id, amount::float8 AS amount, journal_entry_id, link_basis
           FROM public.invoice_payments WHERE invoice_id = ANY($1::uuid[]) ORDER BY amount`,
        [invoices],
      )
      return { a: a.rows[0]!.r, b: b.rows[0]!.r, rows }
    })

    expect(results.a).toMatchObject({ ok: true, invoice_status: 'paid', payment_amount: 500 })
    expect(results.b).toMatchObject({ ok: true, invoice_status: 'paid', payment_amount: 700 })
    expect(results.rows).toEqual([
      { invoice_id: invoices[0], amount: 500, journal_entry_id: vouchers[0], link_basis: 'user_confirmed' },
      { invoice_id: invoices[1], amount: 700, journal_entry_id: vouchers[1], link_basis: 'user_confirmed' },
    ])
  })

  it('match_batch_allocate and create_expense_payout_batch: a garbage actor is refused by the actor CHECKs, as before, and nothing is linked', async () => {
    // Both post a verifikat. A garbage gnubok.actor_type fails the audit row
    // of that verifikat (audit_log_actor_type_check) and a garbage
    // p_actor_type fails committed_actor_type: refusals that predate the
    // link basis and come before any link is written.
    const owner = await seedCompany()
    await getPool().query(
      `INSERT INTO public.chart_of_accounts
         (user_id, company_id, account_number, account_name, account_class, account_type, normal_balance, is_active)
       VALUES ($1, $2, '1930', 'Företagskonto', 1, 'asset', 'debit', true),
              ($1, $2, '2893', 'Skuld till aktieägare', 2, 'liability', 'credit', true)
       ON CONFLICT DO NOTHING`,
      [owner.userId, owner.companyId],
    )
    const si = await sekSupplierInvoice(owner, 400)
    const tx = await bankRow(owner, -400)
    const claimId = randomUUID()
    await getPool().query(
      `INSERT INTO public.expense_claims
         (id, company_id, user_id, claimant_name, description, expense_date, amount_sek, vat_sek, expense_account, liability_account, status)
       VALUES ($1, $2, $3, 'Ägare', 'Kvitto', '2026-08-25', 250, 0, '5410', '2893', 'registered')`,
      [claimId, owner.companyId, owner.userId],
    )
    const payoutTx = await bankRow(owner, -250, '2026-08-31')

    const errors = await withUserContext(owner.userId, async (client) => {
      const attempt = async (sql: string, params: unknown[], setting: string) => {
        await client.query('SAVEPOINT attempt')
        await client.query(`SELECT set_config('gnubok.actor_type', $1, true)`, [setting])
        const message = await client.query(sql, params).then(
          () => null,
          (err: Error) => err.message,
        )
        await client.query('ROLLBACK TO SAVEPOINT attempt')
        return message
      }
      const allocations = JSON.stringify([{ kind: 'supplier_invoice', supplier_invoice_id: si, amount: 400 }])
      const mbaSql = `SELECT public.match_batch_allocate(p_tx_id => $1, p_allocations => $2::jsonb, p_company_id => $3, p_actor_type => $4)`
      const payoutSql = `SELECT public.create_expense_payout_batch(
         p_company_id => $1, p_claim_ids => ARRAY[$2::uuid], p_payout_date => '2026-08-31'::date,
         p_cash_account => '1930', p_transaction_id => $3, p_actor_type => $4)`
      const out = {
        mbaSetting: await attempt(mbaSql, [tx, allocations, owner.companyId, null], 'garbage'),
        mbaParam: await attempt(mbaSql, [tx, allocations, owner.companyId, 'not-an-actor'], ''),
        payoutSetting: await attempt(payoutSql, [owner.companyId, claimId, payoutTx, null], 'garbage'),
        payoutParam: await attempt(payoutSql, [owner.companyId, claimId, payoutTx, 'not-an-actor'], ''),
      }
      await client.query('RESET ROLE')
      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM public.transactions WHERE id = ANY($1::uuid[]) AND journal_entry_id IS NOT NULL`,
        [[tx, payoutTx]],
      )
      return { ...out, linked: rows[0].n }
    })

    expect(errors.mbaSetting).toMatch(/audit_log_actor_type_check/)
    expect(errors.mbaParam).toMatch(/actor_type_check/)
    expect(errors.payoutSetting).toMatch(/audit_log_actor_type_check/)
    expect(errors.payoutParam).toMatch(/actor_type_check/)
    expect(errors.linked).toBe(0)
  })
})
