/**
 * Grants slice 2 against the real schema (migrations 20261018100000-100300):
 * a known supplier's invoice from the inbox, registered and booked without a
 * person when it matches the company's rule exactly.
 *
 * The rule's shape and its creation (only an owner or admin, only as the
 * person approving in the app, a supplier by id, line bookings on accounts a
 * grant may book), and above all the claim gate: every refusal it names for
 * a staged create_supplier_invoice_from_inbox is driven here, and for each
 * the staged operation is asserted still pending with no use recorded (each
 * mismatch kind, above the limit, a revoked rule, a locked period, the kill
 * switch, the key's unattended ceiling, the credential cases, and everything
 * a plain registration of a Swedish supplier's invoice never asks for).
 * Then the completion against the registration verifikat, the review list,
 * the revocation's postings and the detector input.
 *
 * The end-to-end walk through the TypeScript (the MCP staging tool, the
 * door, the executor, the detector, Att göra, behandlingshistorik, the
 * master switch) is tests/pg/grants-supplier-invoices-exit-check.pg.test.ts.
 */
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { roundOre } from '@/lib/money'
import { getPool, withUserContext } from './setup'
import { insertAuthUser, insertCompanyMember, insertPostedJournalEntry, seedCompany } from './fixtures'

interface World {
  userId: string
  companyId: string
  fiscalPeriodId: string
  apiKeyId: string
  supplierId: string
}

const ACCOUNTS: Array<[string, number, string, string]> = [
  ['1930', 1, 'asset', 'debit'],
  ['2440', 2, 'liability', 'credit'],
  ['2614', 2, 'liability', 'credit'],
  ['2641', 2, 'liability', 'debit'],
  ['2645', 2, 'liability', 'debit'],
  ['3740', 3, 'revenue', 'credit'],
  ['4535', 4, 'expense', 'debit'],
  ['4598', 4, 'expense', 'credit'],
  ['6211', 6, 'expense', 'debit'],
  ['6212', 6, 'expense', 'debit'],
  ['6540', 6, 'expense', 'debit'],
  ['6072', 6, 'expense', 'debit'],
]

async function seedWorld(opts: { keyLimit?: number | null; supplierType?: string } = {}): Promise<World> {
  const { userId, companyId, fiscalPeriodId } = await seedCompany()
  for (const [n, c, t, b] of ACCOUNTS) {
    await getPool().query(
      `INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_type, normal_balance)
       VALUES ($1, $2, $3, 'Grant test', $4, $5, $6)`,
      [userId, companyId, n, c, t, b],
    )
  }
  await getPool().query(
    `INSERT INTO public.company_settings (company_id, accounting_method, vat_registered) VALUES ($1, 'accrual', true)
     ON CONFLICT (company_id) DO UPDATE SET accounting_method = 'accrual', defer_invoice_booking = false`,
    [companyId],
  )
  const apiKeyId = await insertKey(userId, companyId, { limit: opts.keyLimit ?? null })
  const supplierId = await insertSupplier({ userId, companyId }, { type: opts.supplierType })
  return { userId, companyId, fiscalPeriodId, apiKeyId, supplierId }
}

async function insertKey(
  userId: string,
  companyId: string,
  opts: { limit?: number | null; serviceAccountId?: string | null; mode?: string } = {},
): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.api_keys (id, user_id, company_id, key_hash, key_prefix, name, scopes, unattended_commit_limit,
                                  service_account_id, mode)
     VALUES ($1, $2, $3, $4, 'gnubok_sk_test', 'Agent key', NULL, $5, $6, $7)`,
    [id, userId, companyId, randomUUID().replaceAll('-', ''), opts.limit ?? null, opts.serviceAccountId ?? null, opts.mode ?? 'live'],
  )
  return id
}

async function insertSupplier(w: Pick<World, 'userId' | 'companyId'>, opts: { name?: string; type?: string } = {}): Promise<string> {
  const { rows } = await getPool().query(
    `INSERT INTO public.suppliers (user_id, company_id, name, supplier_type) VALUES ($1, $2, $3, $4) RETURNING id`,
    [w.userId, w.companyId, opts.name ?? 'Telia Sverige AB', opts.type ?? 'swedish_business'],
  )
  return rows[0].id as string
}

async function insertDocument(w: Pick<World, 'userId' | 'companyId'>): Promise<string> {
  const { rows } = await getPool().query(
    `INSERT INTO public.document_attachments (user_id, company_id, storage_path, file_name, sha256_hash)
     VALUES ($1, $2, $3, 'faktura.pdf', $4) RETURNING id`,
    [w.userId, w.companyId, `${w.companyId}/${randomUUID()}.pdf`, randomUUID().replaceAll('-', '').padEnd(64, '0')],
  )
  return rows[0].id as string
}

async function insertInboxItem(
  w: Pick<World, 'userId' | 'companyId'>,
  opts: { documentId?: string | null; kindHint?: string | null; documentKind?: string } = {},
): Promise<{ inboxItemId: string; documentId: string | null }> {
  const documentId = opts.documentId === undefined ? await insertDocument(w) : opts.documentId
  const { rows } = await getPool().query(
    `INSERT INTO public.invoice_inbox_items (user_id, company_id, document_id, kind_hint, extracted_data)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [w.userId, w.companyId, documentId, opts.kindHint ?? null, JSON.stringify({ documentKind: opts.documentKind ?? 'supplier_invoice' })],
  )
  return { inboxItemId: rows[0].id as string, documentId }
}

interface Line {
  account_number: string
  line_total: number
  vat_rate: number
  [key: string]: unknown
}

/** One line on 6212 at 25 %: 999.20 + 249.80 = 1 249.00. */
function lines(amount = 1249, account = '6212', rate = 0.25): Line[] {
  const net = roundOre(amount / (1 + rate))
  return [
    {
      line_number: 1, description: 'Mobilabonnemang', quantity: 1, unit: 'st', unit_price: net, line_total: net,
      account_number: account, vat_rate: rate, vat_amount: roundOre(amount - net),
    },
  ]
}

async function stageInvoice(
  w: World,
  opts: {
    items?: Line[]
    params?: Record<string, unknown>
    preview?: Record<string, unknown>
    inbox?: { inboxItemId: string; documentId: string | null }
    total?: number
    date?: string
    vat?: string
    actorType?: string
    actorId?: string | null
    supplierId?: string
    status?: string
    batchId?: string | null
  } = {},
): Promise<string> {
  const id = randomUUID()
  const inbox = opts.inbox ?? (await insertInboxItem(w))
  const items = opts.items ?? lines(opts.total ?? 1249)
  const vatAmount = roundOre(items.reduce((s, i) => s + Number(i.vat_amount ?? 0), 0))
  const subtotal = roundOre(items.reduce((s, i) => s + i.line_total, 0))
  const total = opts.total ?? roundOre(subtotal + vatAmount)
  const params = {
    inbox_item_id: inbox.inboxItemId,
    supplier_id: opts.supplierId ?? w.supplierId,
    document_id: inbox.documentId,
    supplier_invoice_number: `F-${randomUUID().slice(0, 8)}`,
    invoice_date: opts.date ?? '2026-06-01',
    due_date: '2026-07-01',
    currency: 'SEK',
    exchange_rate: null,
    vat_treatment: opts.vat ?? 'standard_25',
    payment_reference: null,
    subtotal,
    vat_amount: vatAmount,
    total,
    notes: null,
    items,
    ...(opts.params ?? {}),
  }
  const preview = {
    inbox_item_id: inbox.inboxItemId,
    supplier_id: params.supplier_id,
    supplier_resolution: 'matched',
    supplier_invoice_number: params.supplier_invoice_number,
    invoice_date: params.invoice_date,
    due_date: params.due_date,
    due_date_source: 'extracted',
    currency: 'SEK',
    exchange_rate: null,
    exchange_rate_source: 'not_applicable',
    vat_treatment: params.vat_treatment,
    payment_reference: null,
    subtotal,
    vat_amount: vatAmount,
    total,
    line_count: items.length,
    items_preview: items.slice(0, 5),
    will_post_journal_entry: true,
    will: 'register supplier invoice (status=registered), attach the inbox document, post a registration journal entry on confirm',
    ...(opts.preview ?? {}),
  }
  await getPool().query(
    `INSERT INTO public.pending_operations (id, company_id, user_id, operation_type, title, params, preview_data,
                                            actor_type, actor_id, actor_label, risk_level, status, batch_id)
     VALUES ($1, $2, $3, 'create_supplier_invoice_from_inbox', 'Leverantörsfaktura: Telia', $4, $5, $6, $7, 'Agent key', 'medium', $8, $9)`,
    [id, w.companyId, w.userId, JSON.stringify(params), JSON.stringify(preview), opts.actorType ?? 'api_key',
     opts.actorId === undefined ? w.apiKeyId : opts.actorId, opts.status ?? 'pending', opts.batchId ?? null],
  )
  return id
}

async function createSupplierGrant(
  w: World,
  opts: {
    decidedBy?: string
    actorType?: string | null
    supplierId?: string | null
    itemLines?: string[] | null
    lineAccounts?: string[]
    vat?: string | null
    kind?: string | null
    limit?: number
    monthly?: number | null
    scope?: string
    credentialId?: string | null
    category?: string | null
    accountNumber?: string | null
    counterpartyKey?: string | null
  } = {},
): Promise<Record<string, unknown>> {
  const { rows } = await getPool().query(
    `SELECT public.create_company_grant(
       p_company_id => $1, p_decided_by => $2, p_actor_type => $3, p_actor_label => 'anna@example.se', p_pending_operation_id => NULL,
       p_operation_type => 'create_supplier_invoice_from_inbox', p_counterparty_key => $4, p_counterparty_label => 'Telia Sverige AB',
       p_direction => 'out', p_category => $5, p_vat_treatment => $6, p_reverse_charge_kind => $7, p_account_number => $8,
       p_line_accounts => $9, p_amount_limit_sek => $10, p_monthly_limit_sek => $11, p_credential_scope => $12,
       p_credential_id => $13, p_evidence => '{"booking_count": 5}'::jsonb, p_supplier_id => $14, p_item_lines => $15) AS r`,
    [
      w.companyId,
      opts.decidedBy ?? w.userId,
      opts.actorType === undefined ? 'user' : opts.actorType,
      opts.counterpartyKey ?? null,
      opts.category ?? null,
      opts.vat === undefined ? 'standard_25' : opts.vat,
      opts.kind ?? null,
      opts.accountNumber ?? null,
      opts.lineAccounts ?? ['2440', '2641', '6212'],
      opts.limit ?? 1500,
      opts.monthly ?? null,
      opts.scope ?? 'any',
      opts.credentialId ?? null,
      opts.supplierId === undefined ? w.supplierId : opts.supplierId,
      opts.itemLines === undefined ? ['6212:25'] : opts.itemLines,
    ],
  )
  return rows[0].r as Record<string, unknown>
}

async function claim(operationId: string, apiKeyId: string): Promise<Record<string, unknown>> {
  const { rows } = await getPool().query(`SELECT public.claim_company_grant($1, $2) AS r`, [operationId, apiKeyId])
  return rows[0].r as Record<string, unknown>
}

/** A refusal leaves the operation pending and writes no use. */
async function expectRefused(operationId: string, apiKeyId: string, reason: string) {
  const result = await claim(operationId, apiKeyId)
  expect(result, reason).toMatchObject({ matched: false, reason })
  const { rows: op } = await getPool().query(`SELECT status FROM public.pending_operations WHERE id = $1`, [operationId])
  expect(op[0].status).toBe('pending')
  const { rows: uses } = await getPool().query(`SELECT id FROM public.company_grant_uses WHERE pending_operation_id = $1`, [operationId])
  expect(uses).toEqual([])
}

/** The owner's own session, committed (withUserContext rolls back). */
async function asOwner<T>(userId: string, sql: string, params: unknown[]): Promise<T> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: userId, role: 'authenticated' })])
    await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId])
    await client.query('SET LOCAL ROLE authenticated')
    const { rows } = await client.query(sql, params)
    await client.query('COMMIT')
    return rows[0].r as T
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/** The registration verifikat createSupplierInvoiceRegistrationEntry posts for a plain invoice. */
async function postRegistration(w: World, opts: { amount?: number; account?: string; date?: string; committedAt?: string } = {}) {
  const amount = opts.amount ?? 1249
  const net = roundOre(amount / 1.25)
  return insertPostedJournalEntry({
    userId: w.userId, companyId: w.companyId, fiscalPeriodId: w.fiscalPeriodId, entryDate: opts.date ?? '2026-06-01',
    sourceType: 'supplier_invoice_registered', committedAt: opts.committedAt,
    lines: [
      { accountNumber: opts.account ?? '6212', debitAmount: net, creditAmount: 0 },
      { accountNumber: '2641', debitAmount: roundOre(amount - net), creditAmount: 0 },
      { accountNumber: '2440', debitAmount: 0, creditAmount: amount },
    ],
  })
}

describe('company_grants for supplier invoices: the shape and the decision', () => {
  it('accepts the new type in the CHECK and keeps a supplier rule in its own shape', async () => {
    const w = await seedWorld()
    expect(await createSupplierGrant(w)).toMatchObject({ ok: true, version: 1 })
    const { rows } = await getPool().query(
      `SELECT operation_type, counterparty_key, counterparty_label, direction, category, account_number, supplier_id, item_lines,
              line_accounts, vat_treatment, reverse_charge_kind, accepted_actor_type
         FROM public.company_grants WHERE company_id = $1`,
      [w.companyId],
    )
    expect(rows).toEqual([
      {
        operation_type: 'create_supplier_invoice_from_inbox', counterparty_key: `supplier:${w.supplierId}`, counterparty_label: 'Telia Sverige AB',
        direction: 'out', category: null, account_number: null, supplier_id: w.supplierId, item_lines: ['6212:25'],
        line_accounts: ['2440', '2641', '6212'], vat_treatment: 'standard_25', reverse_charge_kind: null, accepted_actor_type: 'user',
      },
    ])
    // The table refuses a supplier rule out of shape, whoever writes it: a
    // copy of the valid row with one column changed (revoked, so the
    // one-active index stays out of the way).
    const COLUMNS = [
      'company_id', 'operation_type', 'counterparty_key', 'counterparty_label', 'direction', 'category', 'vat_treatment',
      'reverse_charge_kind', 'account_number', 'line_accounts', 'amount_limit_sek', 'accepted_by', 'accepted_actor_type',
      'supplier_id', 'item_lines',
    ]
    const copyWith = (column: string, value: string) =>
      getPool().query(
        `INSERT INTO public.company_grants (${COLUMNS.join(', ')}, version, revoked_at, revoked_reason)
         SELECT ${COLUMNS.map((c) => (c === column ? `${value} AS ${c}` : c)).join(', ')}, 100, now(), 'revoked'
           FROM public.company_grants WHERE company_id = $1 AND version = 1`,
        [w.companyId],
      )
    for (const [why, column, value] of [
      ['a category', 'category', `'expense_software'`],
      ['a business account', 'account_number', `'6212'`],
      ['another key', 'counterparty_key', `'telia'`],
      ['no lines', 'item_lines', `NULL::text[]`],
      ['a line on no account', 'item_lines', `ARRAY['62:25']`],
      ['a foreign rate', 'item_lines', `ARRAY['6212:19']`],
      ['no 2440', 'line_accounts', `ARRAY['2641','6212']`],
      ['reverse charge without a kind', 'vat_treatment', `'reverse_charge'`],
      ['money in', 'direction', `'in'`],
      ['no supplier', 'supplier_id', `NULL::uuid`],
    ] as const) {
      await expect(copyWith(column, value), why).rejects.toThrow(/company_grants_shape_check|company_grants_line_accounts_check/)
    }
    // The unchanged copy is accepted: what failed above was the one column.
    await expect(copyWith('counterparty_label', `'Telia (kopia)'`)).resolves.toBeDefined()
  })

  it("accepts a supplier rule only as the person in the app: an owner's key, the OAuth connector, the in-app assistant, a service account and no actor are refused", async () => {
    const w = await seedWorld()
    for (const actorType of ['api_key', 'mcp_oauth', 'agent_chat', 'service_account', 'cron', 'system', '', null]) {
      expect(await createSupplierGrant(w, { actorType }), String(actorType)).toEqual({ ok: false, code: 'GRANT_NEEDS_PERSON' })
    }
    const member = await insertAuthUser()
    await insertCompanyMember({ companyId: w.companyId, userId: member, role: 'member' })
    expect(await createSupplierGrant(w, { decidedBy: member })).toEqual({ ok: false, code: 'GRANT_ADMIN_REQUIRED' })
    const { rows } = await getPool().query(`SELECT count(*)::int AS n FROM public.company_grants WHERE company_id = $1`, [w.companyId])
    expect(rows[0].n).toBe(0)
  })

  it('refuses an unknown supplier, a line no grant may book, an incomplete verifikat, a VAT treatment out of shape and an inactive account', async () => {
    const w = await seedWorld()
    const other = await seedWorld()
    expect(await createSupplierGrant(w, { supplierId: null })).toEqual({ ok: false, code: 'GRANT_UNKNOWN_SUPPLIER' })
    expect(await createSupplierGrant(w, { supplierId: other.supplierId })).toEqual({ ok: false, code: 'GRANT_UNKNOWN_SUPPLIER' })
    // The slice 1 signature names no supplier: it cannot create a supplier rule.
    const { rows: old } = await getPool().query(
      `SELECT public.create_company_grant($1, $2, 'user', NULL, NULL, 'create_supplier_invoice_from_inbox', NULL, 'Telia', 'out', NULL,
                                          'standard_25', NULL, NULL, ARRAY['2440','2641','6212'], 500) AS r`,
      [w.companyId, w.userId],
    )
    expect(old[0].r).toEqual({ ok: false, code: 'GRANT_UNKNOWN_SUPPLIER' })
    expect(await createSupplierGrant(w, { counterpartyKey: 'telia' })).toMatchObject({ ok: false, code: 'GRANT_INVALID', field: 'counterparty_key' })
    expect(await createSupplierGrant(w, { category: 'expense_software' })).toMatchObject({ ok: false, code: 'GRANT_INVALID', field: 'pattern' })
    expect(await createSupplierGrant(w, { accountNumber: '6212' })).toMatchObject({ ok: false, code: 'GRANT_INVALID', field: 'pattern' })
    for (const itemLines of [[], null, ['6072:25'], ['1220:25'], ['2990:0'], ['8410:0'], ['6212:19'], ['6212']]) {
      expect(await createSupplierGrant(w, { itemLines, lineAccounts: ['1220', '2440', '2641', '2990', '6072', '6212', '8410'] }), JSON.stringify(itemLines))
        .toMatchObject({ ok: false, code: 'GRANT_INVALID', field: 'item_lines' })
    }
    expect(await createSupplierGrant(w, { lineAccounts: ['2641', '6212'] })).toMatchObject({ ok: false, code: 'GRANT_INVALID', field: 'line_accounts' })
    expect(await createSupplierGrant(w, { lineAccounts: ['2440', '2641'] })).toMatchObject({ ok: false, code: 'GRANT_INVALID', field: 'line_accounts' })
    expect(await createSupplierGrant(w, { vat: null })).toMatchObject({ ok: false, code: 'GRANT_INVALID', field: 'vat_treatment' })
    expect(await createSupplierGrant(w, { vat: 'reverse_charge' })).toMatchObject({ ok: false, code: 'GRANT_INVALID', field: 'vat_treatment' })
    expect(await createSupplierGrant(w, { kind: 'eu_services' })).toMatchObject({ ok: false, code: 'GRANT_INVALID', field: 'vat_treatment' })
    expect(await createSupplierGrant(w, { itemLines: ['5410:25'], lineAccounts: ['2440', '2641', '5410'] }))
      .toEqual({ ok: false, code: 'GRANT_ACCOUNT_INACTIVE', account_number: '5410' })
    expect(await createSupplierGrant(w, { scope: 'api_key', credentialId: randomUUID() })).toEqual({ ok: false, code: 'GRANT_CREDENTIAL_UNKNOWN' })
  })

  it('lets a line use a cost account or öresavrundning, never representation, a balance account or class 8', async () => {
    const allowed = ['3740', '4010', '4535', '5410', '6069', '6080', '6212', '7629', '7640', '7999']
    const refused = ['6070', '6071', '6072', '6079', '7630', '7631', '7632', '7639', '8000', '8410', '1220', '1790', '2440', '2990', '3001', '0000', '62', null]
    for (const account of [...allowed, ...refused]) {
      const { rows } = await getPool().query(`SELECT public.grant_item_account_allowed($1) AS a`, [account])
      expect(rows[0].a, String(account)).toBe(allowed.includes(account as string))
    }
  })

  it('creates version 1 with an audit row, a second decision supersedes it, and a revocation answers its postings', async () => {
    const w = await seedWorld()
    const first = await createSupplierGrant(w, { limit: 1000 })
    const second = await createSupplierGrant(w, { limit: 1500 })
    expect(second).toMatchObject({ ok: true, version: 2, superseded_grant_id: first.grant_id })
    const { rows: audit } = await getPool().query(
      `SELECT action, description, new_state->>'supplier_id' AS supplier, new_state->'item_lines' AS lines
         FROM public.audit_log WHERE company_id = $1 AND table_name = 'company_grants' ORDER BY created_at, action`,
      [w.companyId],
    )
    expect(audit.map((a) => a.action).sort()).toEqual(['INSERT', 'INSERT', 'UPDATE'])
    expect(audit.filter((a) => a.action === 'INSERT').every((a) => a.supplier === w.supplierId && JSON.stringify(a.lines) === '["6212:25"]')).toBe(true)

    const op = await stageInvoice(w)
    const claimed = await claim(op, w.apiKeyId)
    expect(claimed).toMatchObject({ matched: true })
    const entry = await postRegistration(w)
    await getPool().query(`SELECT public.complete_company_grant_use($1, $2)`, [claimed.use_id, entry])
    const { rows: op_ } = await getPool().query(`SELECT params->>'inbox_item_id' AS inbox FROM public.pending_operations WHERE id = $1`, [op])
    const supplierInvoiceId = randomUUID()
    await getPool().query(
      `UPDATE public.pending_operations SET status = 'committed', resolved_at = now(),
              result_data = jsonb_build_object('supplier_invoice_id', $2::text, 'registration_journal_entry_id', $3::text)
        WHERE id = $1`,
      [op, supplierInvoiceId, entry],
    )
    const { rows } = await getPool().query(`SELECT public.revoke_company_grant($1, $2, $3, 'user', 'anna@example.se') AS r`, [w.companyId, second.grant_id, w.userId])
    expect(rows[0].r).toMatchObject({
      ok: true, unchanged: false, operation_type: 'create_supplier_invoice_from_inbox', postings_count: 1,
      postings: [expect.objectContaining({ journal_entry_id: entry, inbox_item_id: op_[0].inbox, supplier_invoice_id: supplierInvoiceId, amount_sek: 1249 })],
    })
  })
})

describe('claim_company_grant: a supplier invoice from the inbox, exact match only', () => {
  it('matches an exact staging, records a claimed use on the inbox item, and leaves the operation for the commit', async () => {
    const w = await seedWorld()
    const grant = await createSupplierGrant(w)
    const inbox = await insertInboxItem(w)
    const op = await stageInvoice(w, { inbox })
    const result = await claim(op, w.apiKeyId)
    expect(result).toMatchObject({
      matched: true, company_id: w.companyId, operation_type: 'create_supplier_invoice_from_inbox', grant_id: grant.grant_id,
      grant_version: 1, amount_sek: 1249, counterparty_label: 'Telia Sverige AB',
    })
    const { rows } = await getPool().query(
      `SELECT u.status, u.amount_sek::float AS amount, u.entry_date::text AS date, u.inbox_item_id, u.transaction_id, p.status AS op_status
         FROM public.company_grant_uses u JOIN public.pending_operations p ON p.id = u.pending_operation_id WHERE u.id = $1`,
      [result.use_id],
    )
    expect(rows[0]).toEqual({ status: 'claimed', amount: 1249, date: '2026-06-01', inbox_item_id: inbox.inboxItemId, transaction_id: null, op_status: 'pending' })
    // The same inbox item cannot be claimed twice while the first claim is live.
    await expectRefused(await stageInvoice(w, { inbox }), w.apiKeyId, 'inbox_item_already_claimed')
  })

  it('matches several lines on the same accounts and rates, an öresavrundning line included when the rule names it', async () => {
    const w = await seedWorld()
    await createSupplierGrant(w, { itemLines: ['3740:0', '6211:25', '6212:25'], lineAccounts: ['2440', '2641', '3740', '6211', '6212'] })
    const items: Line[] = [
      ...lines(625, '6212'),
      ...lines(500, '6212'),
      ...lines(124, '6211'),
      { line_number: 4, description: 'Öresavrundning', quantity: 1, unit: 'st', unit_price: 0.2, line_total: 0.2, account_number: '3740', vat_rate: 0, vat_amount: 0 },
    ]
    expect(await claim(await stageInvoice(w, { items }), w.apiKeyId)).toMatchObject({ matched: true })
  })

  it('a non-matching staging stays pending: another account, another VAT rate, an extra line, another treatment, another reverse-charge kind', async () => {
    const w = await seedWorld()
    await createSupplierGrant(w)
    await expectRefused(await stageInvoice(w, { items: lines(1249, '6540') }), w.apiKeyId, 'pattern_mismatch')
    await expectRefused(await stageInvoice(w, { items: lines(1120, '6212', 0.12) }), w.apiKeyId, 'pattern_mismatch')
    await expectRefused(await stageInvoice(w, { items: [...lines(1249), { ...lines(125, '6211')[0], line_number: 2 }] }), w.apiKeyId, 'pattern_mismatch')
    await expectRefused(await stageInvoice(w, { vat: 'reduced_12' }), w.apiKeyId, 'pattern_mismatch')

    // Reverse charge: the rule pins the kind the supplier's type books.
    const rc = await seedWorld({ supplierType: 'eu_business' })
    await createSupplierGrant(rc, { vat: 'reverse_charge', kind: 'eu_services', itemLines: ['6540:0'], lineAccounts: ['2440', '2614', '2645', '4535', '4598', '6540'] })
    const rcItems = [{ ...lines(1000, '6540', 0)[0], vat_amount: 0 }]
    expect(await claim(await stageInvoice(rc, { vat: 'reverse_charge', items: rcItems }), rc.apiKeyId)).toMatchObject({ matched: true })
    await getPool().query(`UPDATE public.suppliers SET supplier_type = 'non_eu_business' WHERE id = $1`, [rc.supplierId])
    await expectRefused(await stageInvoice(rc, { vat: 'reverse_charge', items: rcItems }), rc.apiKeyId, 'pattern_mismatch')
  })

  it("never applies to another supplier, or to one the company does not have", async () => {
    const w = await seedWorld()
    await createSupplierGrant(w)
    const other = await insertSupplier(w, { name: 'Tele2 AB' })
    await expectRefused(await stageInvoice(w, { supplierId: other }), w.apiKeyId, 'no_grant_for_counterparty')
    await expectRefused(await stageInvoice(w, { params: { supplier_id: 'Telia Sverige AB' } }), w.apiKeyId, 'unknown_supplier')
    // A rule whose supplier is gone is inert.
    const gone = await insertSupplier(w, { name: 'Borta AB' })
    await createSupplierGrant(w, { supplierId: gone })
    await getPool().query(`DELETE FROM public.suppliers WHERE id = $1`, [gone])
    await expectRefused(await stageInvoice(w, { supplierId: gone }), w.apiKeyId, 'unknown_supplier')
  })

  it('refuses what a plain registration of a Swedish supplier invoice never asks for', async () => {
    const w = await seedWorld()
    await createSupplierGrant(w)
    const cases: Array<[string, Parameters<typeof stageInvoice>[1]]> = [
      ['register_booked', { params: { mode: 'register_booked', journal_entry_id: randomUUID() } }],
      ['unsupported_params', { params: { rot_rut: { kind: 'rot' } } }],
      ['unsupported_params', { items: [{ ...lines()[0], accrual_period_start: '2026-06-01' }] }],
      ['foreign_currency', { params: { currency: 'EUR' } }],
      ['foreign_currency', { params: { exchange_rate: 11.5 } }],
      ['dimensions', { params: { default_dimensions: { '6': 'P1' } } }],
      ['dimensions', { items: [{ ...lines()[0], dimensions: { '1': 'KS01' } }] }],
      ['special_payroll_tax', { items: [{ ...lines()[0], apply_slp: true }] }],
      ['credit_note', { params: { total: -1249 } }],
      ['credit_note', { params: { subtotal: -999.2 } }],
      ['negative_line', { items: [...lines(), { ...lines(100)[0], line_number: 2, line_total: -80, vat_amount: -20 }] }],
      ['payment_details', { preview: { invoice_account: 'Bankgiro 123-4567', current_supplier_account: 'Bankgiro 765-4321' } }],
      ['payment_details', { preview: { supplier_payment_details_fill: { bankgiro: '123-4567' } } }],
      ['payment_details', { preview: { compliance_warning: 'Fakturan anger ett annat konto.' } }],
      ['preview_warning', { preview: { warning: 'The extracted line amounts include VAT.', line_amounts_interpreted_as: 'gross' } }],
      ['preview_warning', { preview: { payable_recomputed: { reason: 'exempt' } } }],
      ['preview_warning', { preview: { foreign_vat_in_cost: { amount: 12 } } }],
      ['underlag_missing', { params: { document_id: null } }],
    ]
    for (const [reason, opts] of cases) {
      await expectRefused(await stageInvoice(w, opts), w.apiKeyId, reason)
    }
  })

  it('refuses an inbox item that is missing, a credit note, already booked, without its document, or a number already registered', async () => {
    const w = await seedWorld()
    await createSupplierGrant(w)
    await expectRefused(await stageInvoice(w, { params: { inbox_item_id: randomUUID() } }), w.apiKeyId, 'inbox_item_not_found')
    await expectRefused(await stageInvoice(w, { inbox: await insertInboxItem(w, { documentKind: 'credit_note' }) }), w.apiKeyId, 'credit_note')
    await expectRefused(
      await stageInvoice(w, { inbox: await insertInboxItem(w, { kindHint: 'supplier_invoice', documentKind: 'credit_note' }) }),
      w.apiKeyId,
      'credit_note',
    )

    const booked = await insertInboxItem(w)
    const { rows: si } = await getPool().query(
      `INSERT INTO public.supplier_invoices (user_id, company_id, supplier_id, arrival_number, supplier_invoice_number, invoice_date, due_date, total)
       VALUES ($1, $2, $3, 1, 'F-1001', '2026-05-01', '2026-06-01', 1249) RETURNING id`,
      [w.userId, w.companyId, w.supplierId],
    )
    await getPool().query(`UPDATE public.invoice_inbox_items SET created_supplier_invoice_id = $2 WHERE id = $1`, [booked.inboxItemId, si[0].id])
    await expectRefused(await stageInvoice(w, { inbox: booked }), w.apiKeyId, 'inbox_item_already_booked')
    await expectRefused(await stageInvoice(w, { params: { supplier_invoice_number: 'F-1001' } }), w.apiKeyId, 'duplicate_invoice_number')

    // The underlag: none on the item, another document than the staged one, or one not in the archive.
    await expectRefused(await stageInvoice(w, { inbox: await insertInboxItem(w, { documentId: null }), params: { document_id: randomUUID() } }), w.apiKeyId, 'underlag_missing')
    const item = await insertInboxItem(w)
    await expectRefused(await stageInvoice(w, { inbox: item, params: { document_id: await insertDocument(w) } }), w.apiKeyId, 'underlag_missing')
  })

  it('refuses a company that does not book invoices when they are registered, and a staging that showed no verifikat', async () => {
    const w = await seedWorld()
    await createSupplierGrant(w)
    await expectRefused(await stageInvoice(w, { preview: { will_post_journal_entry: false } }), w.apiKeyId, 'registration_not_booked')
    await getPool().query(`UPDATE public.company_settings SET defer_invoice_booking = true WHERE company_id = $1`, [w.companyId])
    await expectRefused(await stageInvoice(w), w.apiKeyId, 'registration_not_booked')
    await getPool().query(`UPDATE public.company_settings SET defer_invoice_booking = false, accounting_method = 'cash' WHERE company_id = $1`, [w.companyId])
    await expectRefused(await stageInvoice(w), w.apiKeyId, 'registration_not_booked')
  })

  it('refuses a staging it cannot read exactly', async () => {
    const w = await seedWorld()
    await createSupplierGrant(w)
    await expectRefused(await stageInvoice(w, { preview: { total: 1300 } }), w.apiKeyId, 'pattern_unreadable')
    await expectRefused(await stageInvoice(w, { items: [{ ...lines()[0], account_number: '62' }] }), w.apiKeyId, 'pattern_unreadable')
    await expectRefused(await stageInvoice(w, { items: [{ ...lines()[0], vat_rate: 0.19 }] }), w.apiKeyId, 'pattern_unreadable')
    await expectRefused(await stageInvoice(w, { params: { invoice_date: '2026-02-30' } }), w.apiKeyId, 'pattern_unreadable')
    await expectRefused(await stageInvoice(w, { vat: 'mixed' }), w.apiKeyId, 'pattern_unreadable')
    // No line at all.
    await expectRefused(await stageInvoice(w, { params: { items: [] } }), w.apiKeyId, 'pattern_unreadable')
  })

  it('an amount above the limit stays pending, and the key ceiling still wins over a higher limit', async () => {
    const w = await seedWorld()
    await createSupplierGrant(w, { limit: 1000 })
    await expectRefused(await stageInvoice(w), w.apiKeyId, 'above_limit')
    const capped = await seedWorld({ keyLimit: 1000 })
    await createSupplierGrant(capped, { limit: 5000 })
    await expectRefused(await stageInvoice(capped), capped.apiKeyId, 'above_unattended_limit')
  })

  it('the monthly limit counts committed and live claimed uses of the invoice month, and not released ones', async () => {
    const w = await seedWorld()
    await createSupplierGrant(w, { limit: 1500, monthly: 2000 })
    const first = await claim(await stageInvoice(w), w.apiKeyId)
    expect(first).toMatchObject({ matched: true })
    await expectRefused(await stageInvoice(w, { date: '2026-06-20' }), w.apiKeyId, 'above_monthly_limit')
    expect(await claim(await stageInvoice(w, { date: '2026-07-02' }), w.apiKeyId)).toMatchObject({ matched: true })
    await getPool().query(`SELECT public.release_company_grant_use($1, 'commit_refused')`, [first.use_id])
    expect(await claim(await stageInvoice(w, { date: '2026-06-25' }), w.apiKeyId)).toMatchObject({ matched: true })
  })

  it('a revoked rule stops applying', async () => {
    const w = await seedWorld()
    const grant = await createSupplierGrant(w)
    await createSupplierGrant(w, { supplierId: await insertSupplier(w, { name: 'Tele2 AB' }) })
    await getPool().query(`SELECT public.revoke_company_grant($1, $2, $3)`, [w.companyId, grant.grant_id, w.userId])
    await expectRefused(await stageInvoice(w), w.apiKeyId, 'no_grant_for_counterparty')
  })

  it('a period-locked invoice date stays pending: locked period, closed period, company lock date, no period', async () => {
    const w = await seedWorld()
    await createSupplierGrant(w)
    await getPool().query(`UPDATE public.fiscal_periods SET locked_at = now() WHERE id = $1`, [w.fiscalPeriodId])
    await expectRefused(await stageInvoice(w), w.apiKeyId, 'period_locked')
    await getPool().query(`UPDATE public.fiscal_periods SET locked_at = NULL, is_closed = true, closed_at = now() WHERE id = $1`, [w.fiscalPeriodId])
    await expectRefused(await stageInvoice(w), w.apiKeyId, 'period_locked')
    await getPool().query(`UPDATE public.fiscal_periods SET is_closed = false, closed_at = NULL WHERE id = $1`, [w.fiscalPeriodId])
    await getPool().query(`UPDATE public.company_settings SET bookkeeping_locked_through = '2026-06-30' WHERE company_id = $1`, [w.companyId])
    await expectRefused(await stageInvoice(w), w.apiKeyId, 'period_locked')
    await getPool().query(`UPDATE public.company_settings SET bookkeeping_locked_through = NULL WHERE company_id = $1`, [w.companyId])
    await expectRefused(await stageInvoice(w, { date: '2027-02-01' }), w.apiKeyId, 'period_locked')
  })

  it('the kill switch stops supplier rules too', async () => {
    const w = await seedWorld()
    await createSupplierGrant(w)
    expect(await asOwner(w.userId, `SELECT public.set_company_grants_paused($1, true) AS r`, [w.companyId])).toMatchObject({ ok: true, paused: true })
    await expectRefused(await stageInvoice(w), w.apiKeyId, 'paused')
  })

  it('never applies to a staging by anyone but this live key of a writing member, outside a batch', async () => {
    const w = await seedWorld()
    await createSupplierGrant(w)
    await expectRefused(await stageInvoice(w, { actorType: 'user', actorId: null }), w.apiKeyId, 'not_a_key_credential')
    await expectRefused(await stageInvoice(w, { actorType: 'agent_chat', actorId: null }), w.apiKeyId, 'not_a_key_credential')
    await expectRefused(await stageInvoice(w, { batchId: randomUUID() }), w.apiKeyId, 'batch_staged')
    const otherKey = await insertKey(w.userId, w.companyId)
    await expectRefused(await stageInvoice(w), otherKey, 'credential_mismatch')
    const testKey = await insertKey(w.userId, w.companyId, { mode: 'test' })
    await expectRefused(await stageInvoice(w, { actorId: testKey }), testKey, 'credential_not_live')
    await getPool().query(`UPDATE public.company_members SET role = 'viewer' WHERE company_id = $1 AND user_id = $2`, [w.companyId, w.userId])
    await expectRefused(await stageInvoice(w), w.apiKeyId, 'credential_not_member')
    await getPool().query(`UPDATE public.company_members SET role = 'owner' WHERE company_id = $1 AND user_id = $2`, [w.companyId, w.userId])
    await getPool().query(`UPDATE public.api_keys SET revoked_at = now() WHERE id = $1`, [w.apiKeyId])
    await expectRefused(await stageInvoice(w), w.apiKeyId, 'credential_revoked')
  })

  it('a rule naming a service account applies to that account only', async () => {
    const w = await seedWorld()
    const { rows } = await getPool().query(
      `INSERT INTO public.service_accounts (company_id, name, sponsor_user_id, created_by) VALUES ($1, 'Bokföringsagent', $2, $2) RETURNING id`,
      [w.companyId, w.userId],
    )
    const serviceAccountId = rows[0].id as string
    const accountKey = await insertKey(w.userId, w.companyId, { serviceAccountId })
    await createSupplierGrant(w, { scope: 'service_account', credentialId: serviceAccountId })
    await expectRefused(await stageInvoice(w), w.apiKeyId, 'credential_not_allowed')
    expect(await claim(await stageInvoice(w, { actorType: 'service_account', actorId: accountKey }), accountKey)).toMatchObject({ matched: true })
  })

  it('leaves a bank-line rule and a supplier rule apart', async () => {
    const w = await seedWorld()
    // Only a bank-line rule: a staged supplier invoice has no rule for its supplier.
    const { rows } = await getPool().query(
      `SELECT public.create_company_grant($1, $2, 'user', NULL, NULL, 'categorize_transaction', 'telia sverige', 'Telia', 'out',
                                          'expense_telecom', 'standard_25', NULL, '6212', ARRAY['1930','2641','6212'], 5000) AS r`,
      [w.companyId, w.userId],
    )
    expect(rows[0].r).toMatchObject({ ok: true })
    await expectRefused(await stageInvoice(w), w.apiKeyId, 'no_grant_for_counterparty')
  })
})

describe('after the commit: the registration verifikat, the review list', () => {
  it('verifies the posted registration against the rule, lists it with its invoice, and flags one that differs', async () => {
    const w = await seedWorld()
    await createSupplierGrant(w)
    const op = await stageInvoice(w)
    const claimed = await claim(op, w.apiKeyId)
    const entry = await postRegistration(w)
    const { rows } = await getPool().query(`SELECT public.complete_company_grant_use($1, $2) AS r`, [claimed.use_id, entry])
    expect(rows[0].r).toEqual({ ok: true, unchanged: false, pattern_verified: true })
    const supplierInvoiceId = randomUUID()
    await getPool().query(
      `UPDATE public.pending_operations SET status = 'committed', resolved_at = now(),
              result_data = jsonb_build_object('supplier_invoice_id', $2::text, 'registration_journal_entry_id', $3::text)
        WHERE id = $1`,
      [op, supplierInvoiceId, entry],
    )
    const listed = await withUserContext(w.userId, (c) =>
      c.query(
        `SELECT journal_entry_id, operation_type, item_lines, supplier_invoice_id, inbox_item_id IS NOT NULL AS has_item, transaction_id,
                account_number, amount_sek::float AS amount, pattern_verified
           FROM public.list_company_grant_postings($1)`,
        [w.companyId],
      ),
    )
    expect(listed.rows).toEqual([
      {
        journal_entry_id: entry, operation_type: 'create_supplier_invoice_from_inbox', item_lines: ['6212:25'], supplier_invoice_id: supplierInvoiceId,
        has_item: true, transaction_id: null, account_number: null, amount: 1249, pattern_verified: true,
      },
    ])

    // Another cost account on the posted verifikat: flagged for review.
    const second = await claim(await stageInvoice(w, { date: '2026-06-02' }), w.apiKeyId)
    const other = await postRegistration(w, { account: '6540', date: '2026-06-02' })
    const { rows: flagged } = await getPool().query(`SELECT public.complete_company_grant_use($1, $2) AS r`, [second.use_id, other])
    expect(flagged[0].r).toMatchObject({ ok: true, pattern_verified: false })
  })

  it('verifies a reverse-charge registration by its payable, not by its debits', async () => {
    const w = await seedWorld({ supplierType: 'eu_business' })
    await createSupplierGrant(w, { vat: 'reverse_charge', kind: 'eu_services', itemLines: ['6540:0'], lineAccounts: ['2440', '2614', '2645', '4535', '4598', '6540'] })
    const claimed = await claim(await stageInvoice(w, { vat: 'reverse_charge', items: [{ ...lines(1000, '6540', 0)[0], vat_amount: 0 }] }), w.apiKeyId)
    expect(claimed).toMatchObject({ matched: true, amount_sek: 1000 })
    const entry = await insertPostedJournalEntry({
      userId: w.userId, companyId: w.companyId, fiscalPeriodId: w.fiscalPeriodId, sourceType: 'supplier_invoice_registered',
      lines: [
        { accountNumber: '6540', debitAmount: 1000, creditAmount: 0 },
        { accountNumber: '2645', debitAmount: 250, creditAmount: 0 },
        { accountNumber: '2614', debitAmount: 0, creditAmount: 250 },
        { accountNumber: '4535', debitAmount: 1000, creditAmount: 0 },
        { accountNumber: '4598', debitAmount: 0, creditAmount: 1000 },
        { accountNumber: '2440', debitAmount: 0, creditAmount: 1000 },
      ],
    })
    const { rows } = await getPool().query(`SELECT public.complete_company_grant_use($1, $2) AS r`, [claimed.use_id, entry])
    expect(rows[0].r).toEqual({ ok: true, unchanged: false, pattern_verified: true })
  })

  it('lists a committed operation whose completion never arrived by its registration verifikat', async () => {
    const w = await seedWorld()
    await createSupplierGrant(w)
    const op = await stageInvoice(w)
    const claimed = await claim(op, w.apiKeyId)
    const entry = await postRegistration(w)
    await getPool().query(
      `UPDATE public.pending_operations SET status = 'committed', resolved_at = now(),
              result_data = jsonb_build_object('supplier_invoice_id', $2::text, 'registration_journal_entry_id', $3::text,
                                               'grant', jsonb_build_object('use_id', $4::text))
        WHERE id = $1`,
      [op, randomUUID(), entry, claimed.use_id],
    )
    const listed = await withUserContext(w.userId, (c) =>
      c.query(`SELECT use_id, journal_entry_id, entry_status FROM public.list_company_grant_postings($1)`, [w.companyId]),
    )
    expect(listed.rows).toEqual([{ use_id: claimed.use_id, journal_entry_id: entry, entry_status: 'posted' }])
  })
})

describe('company_supplier_grant_candidate: the detector input', () => {
  /** An inbox invoice the agent staged and the owner approved, registered and posted. */
  async function approvedInvoice(
    w: World,
    opts: { amount?: number; account?: string; date?: string; dims?: boolean; credited?: boolean; viaGrant?: string; committing?: boolean } = {},
  ) {
    const amount = opts.amount ?? 1249
    const date = opts.date ?? '2026-05-01'
    const inbox = await insertInboxItem(w)
    const op = await stageInvoice(w, {
      inbox,
      items: lines(amount, opts.account ?? '6212'),
      date,
      ...(opts.dims ? { params: { default_dimensions: { '6': 'P1' } } } : {}),
    })
    const { rows: clock } = await getPool().query(`SELECT (now() + interval '1 second')::text AS at`)
    const entry = await postRegistration(w, { amount, account: opts.account, date, committedAt: clock[0].at as string })
    const { rows: si } = await getPool().query(
      `INSERT INTO public.supplier_invoices (user_id, company_id, supplier_id, arrival_number, supplier_invoice_number, invoice_date, due_date,
                                             total, registration_journal_entry_id)
       VALUES ($1, $2, $3, (SELECT coalesce(max(arrival_number), 0) + 1 FROM public.supplier_invoices WHERE company_id = $2),
               $4, $5, '2026-12-31', $6, $7) RETURNING id`,
      [w.userId, w.companyId, w.supplierId, `F-${randomUUID().slice(0, 8)}`, date, amount, entry],
    )
    if (opts.credited) {
      await getPool().query(
        `INSERT INTO public.supplier_invoices (user_id, company_id, supplier_id, arrival_number, supplier_invoice_number, invoice_date, due_date,
                                               total, is_credit_note, credited_invoice_id, status)
         VALUES ($1, $2, $3, (SELECT coalesce(max(arrival_number), 0) + 1 FROM public.supplier_invoices WHERE company_id = $2),
                 $4, $5, '2026-12-31', $6, true, $7, 'credited')`,
        [w.userId, w.companyId, w.supplierId, `K-${randomUUID().slice(0, 8)}`, date, -amount, si[0].id],
      )
    }
    // The executor links the inbox item before it emits the event; the
    // operation is still 'committing' then, its result_data not yet written.
    await getPool().query(`UPDATE public.invoice_inbox_items SET created_supplier_invoice_id = $2 WHERE id = $1`, [inbox.inboxItemId, si[0].id])
    await getPool().query(
      `UPDATE public.pending_operations SET status = $2 WHERE id = $1`,
      [op, opts.committing ? 'committing' : 'committed'],
    )
    if (opts.viaGrant) {
      await getPool().query(
        `INSERT INTO public.company_grant_uses (company_id, grant_id, grant_version, pending_operation_id, entry_date, amount_sek, status, committed_at)
         VALUES ($1, $2, 1, $3, $4, $5, 'committed', now())`,
        [w.companyId, opts.viaGrant, op, date, amount],
      )
    }
  }

  async function candidate(w: World) {
    const { rows } = await getPool().query(`SELECT public.company_supplier_grant_candidate($1, $2, 5) AS r`, [w.companyId, w.supplierId])
    return rows[0].r as Record<string, unknown>
  }

  it('proposes after five approved invoices the same way, the fifth still committing when its event fires, with the evidence', async () => {
    const w = await seedWorld()
    for (const [i, amount] of [1249, 1249, 1349, 1249, 1499].entries()) {
      await approvedInvoice(w, { amount, date: `2026-0${i + 1}-03`, committing: i === 4 })
    }
    expect(await candidate(w)).toEqual({
      candidate: true,
      supplier_id: w.supplierId,
      counterparty_label: 'Telia Sverige AB',
      pattern: { vat_treatment: 'standard_25', reverse_charge_kind: null, item_lines: ['6212:25'], line_accounts: ['2440', '2641', '6212'] },
      booking_count: 5,
      max_amount_sek: 1499,
      last_booked: '2026-05-03',
    })
  })

  it('does not propose with four, with one booked another way, with one credited, with dimensions, or a rule already in place', async () => {
    const w = await seedWorld()
    for (let i = 0; i < 4; i++) await approvedInvoice(w)
    expect(await candidate(w)).toMatchObject({ candidate: false, reason: 'not_enough', booking_count: 4 })
    await approvedInvoice(w, { account: '6540' })
    expect(await candidate(w)).toMatchObject({ candidate: false, reason: 'not_consistent' })
    for (let i = 0; i < 5; i++) await approvedInvoice(w)
    expect(await candidate(w)).toMatchObject({ candidate: true })
    await approvedInvoice(w, { credited: true })
    expect(await candidate(w)).toMatchObject({ candidate: true, booking_count: 5 })
    await approvedInvoice(w, { dims: true })
    expect(await candidate(w)).toMatchObject({ candidate: false, reason: 'not_consistent' })
    for (let i = 0; i < 5; i++) await approvedInvoice(w)
    const grant = await createSupplierGrant(w)
    expect(await candidate(w)).toMatchObject({ candidate: false, reason: 'has_grant' })
    await getPool().query(`SELECT public.revoke_company_grant($1, $2, $3)`, [w.companyId, grant.grant_id, w.userId])
    // What a rule let through is never evidence for the next rule.
    for (let i = 0; i < 5; i++) await approvedInvoice(w, { viaGrant: grant.grant_id as string })
    expect(await candidate(w)).toMatchObject({ candidate: true, booking_count: 5 })
  })

  it('does not propose while paused, for a company that books invoices later, or for a supplier not in the company', async () => {
    const w = await seedWorld()
    for (let i = 0; i < 5; i++) await approvedInvoice(w)
    await asOwner(w.userId, `SELECT public.set_company_grants_paused($1, true) AS r`, [w.companyId])
    expect(await candidate(w)).toMatchObject({ candidate: false, reason: 'paused' })
    await asOwner(w.userId, `SELECT public.set_company_grants_paused($1, false) AS r`, [w.companyId])
    await getPool().query(`UPDATE public.company_settings SET accounting_method = 'cash' WHERE company_id = $1`, [w.companyId])
    expect(await candidate(w)).toMatchObject({ candidate: false, reason: 'registration_not_booked' })
    const other = await seedWorld()
    const { rows } = await getPool().query(`SELECT public.company_supplier_grant_candidate($1, $2, 5) AS r`, [other.companyId, w.supplierId])
    expect(rows[0].r).toEqual({ candidate: false, reason: 'supplier_not_found' })
  })

  it('is for the service role only', async () => {
    const { rows } = await getPool().query(
      `SELECT has_function_privilege('authenticated', 'public.company_supplier_grant_candidate(uuid, uuid, integer, integer)', 'EXECUTE') AS c,
              has_function_privilege('authenticated', 'public.create_company_grant(uuid, uuid, text, text, uuid, text, text, text, text, text, text, text, text, text[], numeric, numeric, text, uuid, jsonb, uuid, text[])', 'EXECUTE') AS g,
              has_function_privilege('anon', 'public.list_company_grant_postings(uuid, boolean, integer)', 'EXECUTE') AS l,
              has_function_privilege('authenticated', 'public.list_company_grant_postings(uuid, boolean, integer)', 'EXECUTE') AS la`,
    )
    expect(rows[0]).toEqual({ c: false, g: false, l: false, la: true })
  })
})
