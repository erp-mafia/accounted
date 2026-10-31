/**
 * Hard blocks on supplier invoices and Inkorg documents (accounted#145,
 * migration 20261031231512) against the real schema, one source type at a
 * time:
 *
 *   1. supplier_invoice_registered: the registration verifikat is judged on
 *      its lines and on its supplier invoice (the supplier card's name, the
 *      total in SEK). A key, an agent, a grant, a one click or a person's
 *      plain commit is refused before a voucher number is drawn; a person's
 *      reviewed commit posts it with a stamp of the invoice amount, and a
 *      booking_review limit is judged on that amount.
 *   2. supplier_invoice_cash_payment: the kontantmetoden payment that books
 *      the purchase, with or without a bank row; the stamp's amount is the
 *      bank row's when it has one.
 *   3. inbox_item: an Inkorg document booked without a bank row, judged on
 *      its matched supplier, the reading's seller and the verifikat's gross.
 *   4. Never judged: the payment of a registered invoice, a supplier credit
 *      note, a customer invoice, an utlägg. And every source type agrees
 *      with BOOKING_REVIEW_SOURCES in src/lib/booking-review/match.ts.
 *
 * Every test runs in one transaction on the connection's own (superuser)
 * role, which stands in for the service role, and is rolled back; a step
 * "as" a person runs in their signed-in session inside a savepoint.
 */
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BOOKING_REVIEW_SOURCES } from '@/lib/booking-review/match'
import { getClient } from './setup'
import { insertAuthUser, insertCompanyMember, seedCompany } from './fixtures'

interface World {
  ownerId: string
  memberId: string
  companyId: string
  fiscalPeriodId: string
  supplierId: string
}

interface StepResult {
  rows: Array<Record<string, unknown>>
  error: { code?: string; message: string } | null
}

type Line = { account_number: string; debit_amount: number; credit_amount: number }

const DATE = '2026-06-01'

/** A 1 250 kr supplier invoice at 25 % moms, as its registration books it. */
const REGISTRATION_25: Line[] = [
  { account_number: '6540', debit_amount: 1000, credit_amount: 0 },
  { account_number: '2641', debit_amount: 250, credit_amount: 0 },
  { account_number: '2440', debit_amount: 0, credit_amount: 1250 },
]

/** The same purchase from abroad under omvänd betalningsskyldighet. */
const REGISTRATION_REVERSE: Line[] = [
  { account_number: '6540', debit_amount: 1000, credit_amount: 0 },
  { account_number: '2645', debit_amount: 250, credit_amount: 0 },
  { account_number: '2614', debit_amount: 0, credit_amount: 250 },
  { account_number: '2440', debit_amount: 0, credit_amount: 1000 },
]

/** The kontantmetoden payment that books the purchase, from the bank. */
const CASH_PAYMENT_25: Line[] = [
  { account_number: '6540', debit_amount: 1000, credit_amount: 0 },
  { account_number: '2641', debit_amount: 250, credit_amount: 0 },
  { account_number: '1930', debit_amount: 0, credit_amount: 1250 },
]

let db: PoolClient
let w: World

beforeEach(async () => {
  const seeded = await seedCompany()
  const memberId = await insertAuthUser()
  await insertCompanyMember({ companyId: seeded.companyId, userId: memberId, role: 'member' })
  db = await getClient()
  await db.query('BEGIN')
  const { rows } = await db.query(
    `INSERT INTO public.suppliers (user_id, company_id, name) VALUES ($1, $2, 'Spotify AB') RETURNING id::text`,
    [seeded.userId, seeded.companyId],
  )
  w = {
    ownerId: seeded.userId,
    memberId,
    companyId: seeded.companyId,
    fiscalPeriodId: seeded.fiscalPeriodId,
    supplierId: rows[0].id as string,
  }
})

afterEach(async () => {
  await db.query('ROLLBACK')
  db.release()
})

/** One statement in its own savepoint, as the connection's own role (null) or a person's session. */
async function step(as: string | null, sql: string, params: unknown[] = []): Promise<StepResult> {
  await db.query('SAVEPOINT step')
  try {
    if (as) {
      await db.query(`SELECT set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)`, [
        JSON.stringify({ sub: as, role: 'authenticated' }),
        as,
      ])
      await db.query('SET LOCAL ROLE authenticated')
    }
    const { rows } = await db.query(sql, params)
    if (as) {
      await db.query('RESET ROLE')
      await db.query(`SELECT set_config('request.jwt.claims', '', true), set_config('request.jwt.claim.sub', '', true)`)
    }
    await db.query('RELEASE SAVEPOINT step')
    return { rows, error: null }
  } catch (err) {
    await db.query('ROLLBACK TO SAVEPOINT step')
    const e = err as { code?: string; message?: string }
    return { rows: [], error: { code: e.code, message: e.message ?? String(err) } }
  }
}

const SAVE_SQL = `SELECT public.save_booking_review_rule($1::uuid, $2::text[], $3::text, $4::numeric, $5::text, NULL, NULL) AS r`

/** A block saved by the owner. */
async function saveRule(args: { accounts?: string[]; counterparty?: string; amountFrom?: number; vat?: string }) {
  const result = await step(w.ownerId, SAVE_SQL, [
    w.companyId,
    args.accounts ?? null,
    args.counterparty ?? null,
    args.amountFrom ?? null,
    args.vat ?? null,
  ])
  if (result.error) throw new Error(`save_booking_review_rule refused: ${result.error.message}`)
  return result.rows[0].r as { id: string; rule_id: string; version: number }
}

/** A registered supplier invoice of the supplier, its total in its currency. */
async function supplierInvoice(opts: { total?: number; currency?: string; rate?: number | null; totalSek?: number | null } = {}) {
  const id = randomUUID()
  await db.query(
    `INSERT INTO public.supplier_invoices
       (id, user_id, company_id, supplier_id, arrival_number, supplier_invoice_number, invoice_date, due_date,
        currency, exchange_rate, subtotal, vat_amount, total, total_sek, remaining_amount)
     VALUES ($1, $2, $3, $4, floor(random() * 1000000)::int, $5, $6, '2026-07-01', $7, $8, $9 * 0.8, $9 * 0.2, $9, $10, $9)`,
    [id, w.ownerId, w.companyId, w.supplierId, `F-${id.slice(0, 8)}`, DATE, opts.currency ?? 'SEK', opts.rate ?? null, opts.total ?? 1250, opts.totalSek ?? null],
  )
  return id
}

async function insertTx(amount = -1250): Promise<string> {
  const id = randomUUID()
  await db.query(
    `INSERT INTO public.transactions (id, company_id, user_id, currency, amount, date, description, merchant_name, category)
     VALUES ($1, $2, $3, 'SEK', $4, $5, 'BG 5555-1234', NULL, 'uncategorized')`,
    [id, w.companyId, w.ownerId, amount, DATE],
  )
  return id
}

/** A draft of the source type, pointing at its document, with a bank row when txId is given. */
async function draft(sourceType: string, lines: Line[], opts: { sourceId?: string | null; txId?: string } = {}) {
  const entryId = randomUUID()
  const context = opts.txId
    ? [{ transaction_id: opts.txId, cash_account_id: null, settlement_account: '1930', date: DATE, amount: -1250, currency: 'SEK' }]
    : null
  await db.query(
    `INSERT INTO public.journal_entries (id, company_id, user_id, fiscal_period_id, voucher_number, entry_date, description,
                                         source_type, source_id, status, bank_booking_context)
     VALUES ($1, $2, $3, $4, 0, $5, 'PG booking review', $6, $7, 'draft', $8::jsonb)`,
    [entryId, w.companyId, w.ownerId, w.fiscalPeriodId, DATE, sourceType, opts.sourceId ?? null, JSON.stringify(context ?? [])],
  )
  for (const line of lines) {
    await db.query(
      `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount) VALUES ($1, $2, $3, $4)`,
      [entryId, line.account_number, line.debit_amount, line.credit_amount],
    )
  }
  return entryId
}

async function matches(entryId: string): Promise<unknown[]> {
  const { rows } = await db.query('SELECT public.booking_review_entry_matches($1, $2) AS m', [w.companyId, entryId])
  return rows[0].m as unknown[]
}

const COMMIT_SQL = 'SELECT * FROM public.commit_journal_entry($1, $2, $3, NULL, $4, NULL)'
const REVIEWED_SQL = 'SELECT * FROM public.commit_reviewed_journal_entry($1, $2, $3, NULL, NULL)'

function commitAs(entryId: string, actorType: string | null, method: string | null, as: string | null = null) {
  return step(as, COMMIT_SQL, [w.companyId, entryId, method, actorType])
}

async function entryState(entryId: string) {
  const { rows } = await db.query('SELECT status, voucher_number FROM public.journal_entries WHERE id = $1', [entryId])
  return rows[0] as { status: string; voucher_number: number }
}

async function stamp(entryId: string) {
  const { rows } = await db.query(
    `SELECT reviewed_by::text, amount_sek::float8 AS amount_sek, limit_sek::float8 AS limit_sek
       FROM public.booking_review_stamps WHERE journal_entry_id = $1`,
    [entryId],
  )
  return rows[0] as { reviewed_by: string; amount_sek: number; limit_sek: number | null } | undefined
}

function expectRefused(result: StepResult, prefix: string) {
  expect(result.error, `expected ${prefix}`).not.toBeNull()
  expect(result.error!.message.startsWith(prefix), result.error!.message).toBe(true)
}

/** Every door that is no person's review: a key, an agent, a bulk accept or one click, cron, the person's own plain commit. */
const UNREVIEWED: Array<[string | null, string | null, 'owner' | null]> = [
  ['api_key', 'api_key', null],
  ['mcp_oauth', 'api_key', null],
  ['agent_chat', 'agent', null],
  ['user', 'bulk_accept', null],
  ['user', 'user_accept', null],
  [null, null, null],
  ['user', 'user_accept', 'owner'],
]

async function expectUnreviewedRefused(entryId: string) {
  for (const [actor, method, as] of UNREVIEWED) {
    expectRefused(await commitAs(entryId, actor, method, as === 'owner' ? w.ownerId : null), 'BOOKING_REVIEW_REQUIRED')
    expect(await entryState(entryId)).toMatchObject({ status: 'draft', voucher_number: 0 })
  }
}

// ── 1. A supplier invoice's registration ─────────────────────────────

describe('supplier_invoice_registered', () => {
  it('refuses every door but a person review when the supplier is blocked, and stamps the invoice amount', async () => {
    await saveRule({ counterparty: 'Spotify AB' })
    const entryId = await draft('supplier_invoice_registered', REGISTRATION_25, { sourceId: await supplierInvoice() })
    await expectUnreviewedRefused(entryId)

    const posted = await step(w.memberId, REVIEWED_SQL, [w.companyId, entryId, null])
    expect(posted.error).toBeNull()
    expect(posted.rows[0].voucher_number).toBe(1)
    expect(await entryState(entryId)).toMatchObject({ status: 'posted', voucher_number: 1 })
    expect(await stamp(entryId)).toMatchObject({ reviewed_by: w.memberId, amount_sek: 1250, limit_sek: null })
  })

  it('matches each criterion on its own: accounts, VAT, the supplier, the amount in SEK', async () => {
    const sek = await supplierInvoice()
    const euro = await supplierInvoice({ total: 100, currency: 'EUR', rate: 11.5 })
    const euroBooked = await supplierInvoice({ total: 100, currency: 'EUR', rate: 11.5, totalSek: 1100 })
    const cases: Array<[string, Parameters<typeof saveRule>[0], Line[], string, boolean]> = [
      ['a blocked cost account', { accounts: ['6540'] }, REGISTRATION_25, sek, true],
      ['another account', { accounts: ['5410'] }, REGISTRATION_25, sek, false],
      ['blocked 25 % moms', { vat: 'standard_25' }, REGISTRATION_25, sek, true],
      ['blocked reverse charge', { vat: 'reverse_charge' }, REGISTRATION_REVERSE, sek, true],
      ['reverse charge on a 25 % invoice', { vat: 'reverse_charge' }, REGISTRATION_25, sek, false],
      ['another supplier', { counterparty: 'Telia Sverige AB' }, REGISTRATION_25, sek, false],
      ['an amount the invoice reaches', { amountFrom: 1250 }, REGISTRATION_25, sek, true],
      ['an amount above it', { amountFrom: 1251 }, REGISTRATION_25, sek, false],
      ['a foreign total at its rate', { amountFrom: 1150 }, REGISTRATION_25, euro, true],
      ['above a foreign total at its rate', { amountFrom: 1151 }, REGISTRATION_25, euro, false],
      ['the booked SEK total first', { amountFrom: 1101 }, REGISTRATION_25, euroBooked, false],
      ['the supplier from an amount', { counterparty: 'Spotify AB', amountFrom: 1000 }, REGISTRATION_25, sek, true],
    ]
    for (const [label, rule, lines, invoiceId, expected] of cases) {
      await db.query('SAVEPOINT rule_case')
      await saveRule(rule)
      const entryId = await draft('supplier_invoice_registered', lines, { sourceId: invoiceId })
      expect((await matches(entryId)).length > 0, label).toBe(expected)
      await db.query('ROLLBACK TO SAVEPOINT rule_case')
    }
  })

  it('judges a booking_review limit on the invoice amount', async () => {
    await saveRule({ accounts: ['6540'] })
    await db.query(
      `INSERT INTO public.company_attest_limits (company_id, user_id, scope, max_amount_sek, updated_by)
       VALUES ($1, $2, 'booking_review', 1000, $2), ($1, $3, 'booking_review', 5000, $2)`,
      [w.companyId, w.ownerId, w.memberId],
    )
    const entryId = await draft('supplier_invoice_registered', REGISTRATION_25, { sourceId: await supplierInvoice() })
    expectRefused(await step(w.ownerId, REVIEWED_SQL, [w.companyId, entryId, null]), 'BOOKING_REVIEW_LIMIT')
    expect(await entryState(entryId)).toMatchObject({ status: 'draft', voucher_number: 0 })
    expect((await step(w.memberId, REVIEWED_SQL, [w.companyId, entryId, null])).error).toBeNull()
    expect(await stamp(entryId)).toMatchObject({ reviewed_by: w.memberId, amount_sek: 1250, limit_sek: 5000 })
  })

  it('commits as before when no block matches, from any door', async () => {
    await saveRule({ accounts: ['5410'] })
    const entryId = await draft('supplier_invoice_registered', REGISTRATION_25, { sourceId: await supplierInvoice() })
    const posted = await commitAs(entryId, 'api_key', 'api_key')
    expect(posted.error).toBeNull()
    expect(await stamp(entryId)).toBeUndefined()
  })
})

// ── 2. A kontantmetoden payment that books the purchase ──────────────

describe('supplier_invoice_cash_payment', () => {
  it('is judged on its supplier, and its stamp carries the bank row the payment left by', async () => {
    await saveRule({ counterparty: 'Spotify AB' })
    // The invoice says 1 300; the bank row that settled it moved 1 250.
    const entryId = await draft('supplier_invoice_cash_payment', CASH_PAYMENT_25, {
      sourceId: await supplierInvoice({ total: 1300 }),
      txId: await insertTx(-1250),
    })
    await expectUnreviewedRefused(entryId)
    expect((await step(w.ownerId, REVIEWED_SQL, [w.companyId, entryId, null])).error).toBeNull()
    expect(await stamp(entryId)).toMatchObject({ reviewed_by: w.ownerId, amount_sek: 1250 })
  })

  it('is judged without a bank row too (mark-paid), on the invoice amount', async () => {
    await saveRule({ amountFrom: 1000 })
    const entryId = await draft('supplier_invoice_cash_payment', CASH_PAYMENT_25, { sourceId: await supplierInvoice() })
    expectRefused(await commitAs(entryId, 'api_key', 'api_key'), 'BOOKING_REVIEW_REQUIRED')
    expect((await step(w.ownerId, REVIEWED_SQL, [w.companyId, entryId, null])).error).toBeNull()
    expect(await stamp(entryId)).toMatchObject({ amount_sek: 1250 })
  })
})

// ── 3. An Inkorg document booked without a bank row ──────────────────

describe('inbox_item', () => {
  async function inboxItem(opts: { matchedSupplier?: boolean; sellerName?: string | null } = {}) {
    const { rows } = await db.query(
      `INSERT INTO public.invoice_inbox_items (company_id, user_id, source, status, matched_supplier_id, extracted_data)
       VALUES ($1, $2, 'upload', 'received', $3, $4::jsonb) RETURNING id::text`,
      [
        w.companyId,
        w.ownerId,
        opts.matchedSupplier ? w.supplierId : null,
        JSON.stringify({ supplier: { name: opts.sellerName ?? null } }),
      ],
    )
    return rows[0].id as string
  }

  it('is judged on its matched supplier, the seller the reading names, and the gross', async () => {
    const lines = CASH_PAYMENT_25
    const cases: Array<[string, Parameters<typeof saveRule>[0], { matchedSupplier?: boolean; sellerName?: string | null }, boolean]> = [
      ['the matched supplier', { counterparty: 'Spotify AB' }, { matchedSupplier: true }, true],
      ['the seller the reading names', { counterparty: 'Wispr Flow' }, { sellerName: 'Wispr Flow' }, true],
      ['another seller', { counterparty: 'Telia Sverige AB' }, { matchedSupplier: true, sellerName: 'Spotify AB' }, false],
      ['the gross', { amountFrom: 1250 }, {}, true],
      ['above the gross', { amountFrom: 1251 }, {}, false],
      ['a blocked account', { accounts: ['6540'] }, {}, true],
    ]
    for (const [label, rule, item, expected] of cases) {
      await db.query('SAVEPOINT rule_case')
      await saveRule(rule)
      const entryId = await draft('inbox_item', lines, { sourceId: await inboxItem(item) })
      expect((await matches(entryId)).length > 0, label).toBe(expected)
      await db.query('ROLLBACK TO SAVEPOINT rule_case')
    }
  })

  it('refuses a one click and posts from a person review, stamped with the gross', async () => {
    await saveRule({ vat: 'standard_25' })
    const entryId = await draft('inbox_item', CASH_PAYMENT_25, { sourceId: await inboxItem({ matchedSupplier: true }) })
    await expectUnreviewedRefused(entryId)
    expect((await step(w.ownerId, REVIEWED_SQL, [w.companyId, entryId, null])).error).toBeNull()
    expect(await stamp(entryId)).toMatchObject({ amount_sek: 1250 })
  })
})

// ── 4. What a block never judges, and the TypeScript mirror ──────────

describe('the source types a block judges', () => {
  it.each([
    ['the payment of a registered invoice', 'supplier_invoice_paid', [
      { account_number: '2440', debit_amount: 1250, credit_amount: 0 },
      { account_number: '1930', debit_amount: 0, credit_amount: 1250 },
    ]],
    ['a supplier credit note', 'supplier_credit_note', [
      { account_number: '2440', debit_amount: 1250, credit_amount: 0 },
      { account_number: '6540', debit_amount: 0, credit_amount: 1000 },
      { account_number: '2641', debit_amount: 0, credit_amount: 250 },
    ]],
    ['a customer invoice', 'invoice_created', [
      { account_number: '1510', debit_amount: 1250, credit_amount: 0 },
      { account_number: '3001', debit_amount: 0, credit_amount: 1000 },
      { account_number: '2611', debit_amount: 0, credit_amount: 250 },
    ]],
    ['an utlägg', 'expense_claim', [
      { account_number: '6540', debit_amount: 1000, credit_amount: 0 },
      { account_number: '2641', debit_amount: 250, credit_amount: 0 },
      { account_number: '2893', debit_amount: 0, credit_amount: 1250 },
    ]],
  ] as Array<[string, string, Line[]]>)('never judges %s: a key commits it as before', async (_case, sourceType, lines) => {
    await saveRule({ amountFrom: 1 })
    await saveRule({ accounts: [...new Set(lines.map((l) => l.account_number))] })
    await saveRule({ vat: 'standard_25' })
    const entryId = await draft(sourceType, lines, { sourceId: sourceType.startsWith('supplier') ? await supplierInvoice() : null })
    expect(await matches(entryId)).toEqual([])
    const posted = await commitAs(entryId, 'api_key', 'api_key')
    expect(posted.error).toBeNull()
    expect(await entryState(entryId)).toMatchObject({ status: 'posted' })
  })

  it('agrees with BOOKING_REVIEW_SOURCES for every source type a draft can carry', async () => {
    await saveRule({ accounts: ['6540'] })
    const judged: string[] = []
    const checked: string[] = []
    for (const [sourceType, source] of Object.entries(BOOKING_REVIEW_SOURCES)) {
      // A draft with the blocked account and no bank row or document behind
      // it: the lines alone decide, for every source type a block judges.
      await db.query('SAVEPOINT source_case')
      let entryId: string
      try {
        entryId = await draft(sourceType, REGISTRATION_25)
      } catch {
        // A source type the schema refuses on a bare draft (an import needs
        // its batch): nothing can be judged on it here.
        await db.query('ROLLBACK TO SAVEPOINT source_case')
        continue
      }
      const matched = (await matches(entryId)).length > 0
      expect(matched, sourceType).toBe(source === 'supplier_invoice' || source === 'inbox_item')
      if (matched) judged.push(sourceType)
      checked.push(sourceType)
      await db.query('ROLLBACK TO SAVEPOINT source_case')
    }
    expect(judged.sort()).toEqual(['inbox_item', 'supplier_invoice_cash_payment', 'supplier_invoice_registered'])
    expect(checked).toEqual(expect.arrayContaining(['bank_transaction', 'manual', 'supplier_invoice_paid', 'invoice_created', 'storno']))
  })
})
