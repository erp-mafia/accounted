/**
 * categorizeTransaction: the rules every categorize door now shares.
 *
 * Each door used to decide these on its own: whether a dry run runs the
 * guards, what a row a verifikat already books gets, whether a stale pointer
 * at a reversed verifikat blocks a new booking, how the inbox item a booking
 * started from is completed, and whether a reverse-charge booking may land on
 * an invoice where the seller charged moms.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase, makeCategorizationTemplate } from '@/tests/helpers'

const { createTxJE, propagate, saveRule, intercept, lock } = vi.hoisted(() => ({
  createTxJE: vi.fn(),
  propagate: vi.fn(),
  saveRule: vi.fn(),
  intercept: vi.fn(),
  lock: vi.fn(),
}))

vi.mock('@/lib/bookkeeping/transaction-entries', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/bookkeeping/transaction-entries')>()),
  createTransactionJournalEntry: createTxJE,
}))
vi.mock('@/lib/transactions/booking-duplicate-detection', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/transactions/booking-duplicate-detection')>()),
  detectBookingDuplicate: vi.fn().mockResolvedValue(null),
}))
vi.mock('@/lib/suggestion-log/record', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/suggestion-log/record')>()),
  snapshotSuggestions: vi.fn(async (_s: unknown, companyId: string) => ({ companyId, byTransaction: new Map() })),
  recordDecisions: vi.fn(async () => undefined),
}))
vi.mock('@/lib/bookkeeping/account-validation', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/bookkeeping/account-validation')>()),
  findUnresolvableAccounts: vi.fn().mockResolvedValue([]),
}))
vi.mock('@/lib/api/v1/check-period-lock', () => ({ checkPeriodLock: lock }))
vi.mock('@/lib/transactions/inbox-underlag', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/transactions/inbox-underlag')>()),
  propagateUnderlagForBookedTransaction: propagate,
}))
vi.mock('@/lib/bookkeeping/counterparty-templates', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/bookkeeping/counterparty-templates')>()),
  upsertCounterpartyTemplate: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/bookkeeping/mapping-engine', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/bookkeeping/mapping-engine')>()),
  saveUserMappingRule: saveRule,
}))
vi.mock('@/lib/invoices/invoice-match-suggestion', () => ({
  findInvoiceMatchSuggestion: intercept,
}))

import { categorizeTransaction, type CategorizeOptions } from '../categorize-core'
import { upsertCounterpartyTemplate } from '@/lib/bookkeeping/counterparty-templates'
import { detectBookingDuplicate } from '@/lib/transactions/booking-duplicate-detection'
import { recordDecisions, snapshotSuggestions } from '@/lib/suggestion-log/record'

const COMPANY_ID = 'company-1'
const TX_ID = 'tx-1'

const row = (over: Record<string, unknown> = {}) => ({
  id: TX_ID,
  company_id: COMPANY_ID,
  date: '2026-05-12',
  amount: -1250,
  currency: 'SEK',
  amount_sek: -1250,
  exchange_rate: 1,
  description: 'KONTORSBOLAGET',
  merchant_name: 'Kontorsbolaget',
  cash_account_id: null,
  document_id: null,
  journal_entry_id: null,
  transaction_voucher_links: [],
  ...over,
})

function ledger(tables: Parameters<typeof createTableMockSupabase>[0] = {}) {
  return createTableMockSupabase({
    transactions: [{ data: row(), error: null }, { data: [row({ journal_entry_id: 'je-1' })], error: null }],
    company_settings: { data: { entity_type: 'aktiebolag', fiscal_year_start_month: 1, vat_registered: true }, error: null },
    cash_accounts: { data: [], error: null },
    fiscal_periods: { data: [{ id: 'fp-1' }], error: null },
    ...tables,
  })
}

const business = { is_business: true, category: 'expense_office' } as const
const live: CategorizeOptions = { onBooked: 'update_flags' }

beforeEach(() => {
  vi.clearAllMocks()
  createTxJE.mockResolvedValue({ id: 'je-1', lines: [] })
  propagate.mockResolvedValue(undefined)
  saveRule.mockResolvedValue(undefined)
  intercept.mockResolvedValue(null)
  lock.mockResolvedValue({ locked: false })
})

describe('categorizeTransaction: dry run', () => {
  it('answers with the lines the booking posts and writes nothing', async () => {
    const { supabase, payloads } = ledger()

    const outcome = await categorizeTransaction(supabase as never, 'user-1', COMPANY_ID, TX_ID, business, {
      ...live,
      dryRun: true,
    })

    expect(outcome.ok && outcome.dryRun).toBe(true)
    if (!outcome.ok || !outcome.dryRun) return
    expect(outcome.preview.would_create_journal_entry).toBe(true)
    const lines = outcome.preview.lines
    const debit = lines.reduce((sum, l) => sum + l.debit_amount, 0)
    const credit = lines.reduce((sum, l) => sum + l.credit_amount, 0)
    expect(Math.round(debit * 100)).toBe(Math.round(credit * 100))
    expect(lines).toContainEqual(expect.objectContaining({ account_number: '1930', credit_amount: 1250 }))
    expect(createTxJE).not.toHaveBeenCalled()
    expect(payloads('transactions', 'update')).toEqual([])
    expect(payloads('fiscal_periods', 'upsert')).toEqual([])
  })

  it('runs the period lock and the invoice-match intercept like the booking', async () => {
    lock.mockResolvedValue({ locked: true, reason: 'period_locked_at_set', fiscal_period_id: 'fp-1' })

    const locked = await categorizeTransaction(ledger().supabase as never, 'user-1', COMPANY_ID, TX_ID, business, {
      ...live,
      dryRun: true,
    })
    expect(locked).toMatchObject({ ok: false, code: 'PERIOD_LOCKED', details: { reason: 'period_locked_at_set' } })

    lock.mockResolvedValue({ locked: false })
    intercept.mockResolvedValue({ code: 'TX_CATEGORIZE_SUGGEST_SI_MATCH', details: { candidates: [] } })
    const matched = await categorizeTransaction(ledger().supabase as never, 'user-1', COMPANY_ID, TX_ID, business, {
      ...live,
      dryRun: true,
    })
    expect(matched).toMatchObject({ ok: false, code: 'TX_CATEGORIZE_SUGGEST_SI_MATCH' })
  })

  it('hands the invoice-match intercept the row, the mapping\'s accounts and the override, and refuses with its code and details', async () => {
    const candidates = [{ supplier_invoice_id: 'si-1' }]
    intercept.mockResolvedValue({ code: 'TX_CATEGORIZE_SUGGEST_SI_MATCH', details: { candidates } })
    const { supabase } = ledger()

    const outcome = await categorizeTransaction(supabase as never, 'user-1', COMPANY_ID, TX_ID, { ...business, confirm_no_match: false }, {
      ...live,
      dryRun: true,
    })

    expect(outcome).toMatchObject({ ok: false, code: 'TX_CATEGORIZE_SUGGEST_SI_MATCH', details: { candidates } })
    expect(intercept).toHaveBeenCalledTimes(1)
    const [client, companyId, input, log] = intercept.mock.calls[0]!
    expect(client).toBe(supabase)
    expect(companyId).toBe(COMPANY_ID)
    expect(input).toEqual({
      transaction: expect.objectContaining({ id: TX_ID, amount: -1250, merchant_name: 'Kontorsbolaget' }),
      debitAccount: '6110',
      creditAccount: '1930',
      isBusiness: true,
      confirmNoMatch: false,
    })
    expect(typeof (log as { warn?: unknown }).warn).toBe('function')
  })

  it('leaves the invoice-match intercept to the doors that keep it', async () => {
    intercept.mockResolvedValue({ code: 'TX_CATEGORIZE_SUGGEST_SI_MATCH', details: { candidates: [] } })

    const outcome = await categorizeTransaction(ledger().supabase as never, 'user-1', COMPANY_ID, TX_ID, business, {
      onBooked: 'refuse',
      dryRun: true,
      invoiceMatchIntercept: false,
    })

    expect(outcome.ok).toBe(true)
    expect(intercept).not.toHaveBeenCalled()
  })
})

describe('categorizeTransaction: a row a verifikat already books', () => {
  const booked = () =>
    ledger({
      transactions: { data: row({ journal_entry_id: 'je-old' }), error: null },
      journal_entries: { data: [{ id: 'je-old', status: 'posted' }], error: null },
    })

  it('updates the flags only on the dashboard and v1 doors', async () => {
    const { supabase, payloads } = booked()

    const outcome = await categorizeTransaction(supabase as never, 'user-1', COMPANY_ID, TX_ID, business, live)

    expect(outcome).toMatchObject({
      ok: true,
      dryRun: false,
      booked: { journal_entry_created: false, journal_entry_id: 'je-old', already_had_journal_entry: true },
    })
    expect(payloads('transactions', 'update')).toEqual([
      { is_business: true, category: 'expense_office', is_ignored: false },
    ])
    expect(createTxJE).not.toHaveBeenCalled()
  })

  it('refuses on the approval doors, which must not report a booking that did not happen', async () => {
    const { supabase, payloads } = booked()

    const outcome = await categorizeTransaction(supabase as never, 'user-1', COMPANY_ID, TX_ID, business, {
      onBooked: 'refuse',
    })

    expect(outcome).toMatchObject({
      ok: false,
      code: 'TRANSACTION_ALREADY_CATEGORIZED',
      details: { journal_entry_id: 'je-old', via: 'pointer' },
    })
    expect(payloads('transactions', 'update')).toEqual([])
  })

  it('books a row whose pointer names a reversed verifikat, compare-and-set on that pointer', async () => {
    const { supabase, findCalls } = ledger({
      transactions: [
        { data: row({ journal_entry_id: 'je-reversed' }), error: null },
        { data: [row({ journal_entry_id: 'je-1' })], error: null },
      ],
      journal_entries: { data: [{ id: 'je-reversed', status: 'reversed' }], error: null },
    })

    const outcome = await categorizeTransaction(supabase as never, 'user-1', COMPANY_ID, TX_ID, business, live)

    expect(outcome).toMatchObject({ ok: true, booked: { journal_entry_created: true, journal_entry_id: 'je-1' } })
    expect(findCalls('transactions', 'eq')).toContainEqual(['journal_entry_id', 'je-reversed'])
  })
})

describe('categorizeTransaction: after the booking', () => {
  it('matches the inbox item the booking started from, then propagates its underlag', async () => {
    const { supabase, findCalls, payloads } = ledger()

    const outcome = await categorizeTransaction(
      supabase as never,
      'user-1',
      COMPANY_ID,
      TX_ID,
      { ...business, inbox_item_id: 'inbox-1' },
      live,
    )

    expect(outcome.ok).toBe(true)
    expect(payloads('invoice_inbox_items', 'update')).toEqual([{ matched_transaction_id: TX_ID }])
    // Only an item nothing has consumed yet joins the row.
    expect(findCalls('invoice_inbox_items', 'is')).toEqual([
      ['created_journal_entry_id', null],
      ['created_supplier_invoice_id', null],
    ])
    expect(propagate).toHaveBeenCalledWith(supabase, COMPANY_ID, TX_ID, 'je-1')
  })

  it('learns the merchant rule only from a booking that won its write', async () => {
    const won = await categorizeTransaction(ledger().supabase as never, 'user-1', COMPANY_ID, TX_ID, business, live)
    expect(won.ok).toBe(true)
    expect(saveRule).toHaveBeenCalledTimes(1)

    vi.clearAllMocks()
    createTxJE.mockResolvedValue({ id: 'je-1', lines: [] })
    const { supabase } = ledger({ transactions: [{ data: row(), error: null }, { data: [], error: null }] })
    const lost = await categorizeTransaction(supabase as never, 'user-1', COMPANY_ID, TX_ID, business, live)
    expect(lost).toMatchObject({ ok: false, code: 'TX_CATEGORIZE_RACE' })
    expect(saveRule).not.toHaveBeenCalled()
  })

  it('names the counterpart template the row was booked on to the learner (accounted#36)', async () => {
    const template = makeCategorizationTemplate({
      id: 'tmpl-1',
      company_id: COMPANY_ID,
      debit_account: '5410',
      credit_account: '1930',
      vat_treatment: null,
      vat_account: null,
    })
    const { supabase } = ledger({ categorization_templates: { data: template, error: null } })

    const booked = await categorizeTransaction(
      supabase as never,
      'user-1',
      COMPANY_ID,
      TX_ID,
      { is_business: true, counterparty_template_id: 'tmpl-1' },
      live,
    )

    expect(booked.ok).toBe(true)
    expect(upsertCounterpartyTemplate).toHaveBeenCalledWith(
      supabase,
      COMPANY_ID,
      expect.objectContaining({ id: TX_ID }),
      expect.objectContaining({ debit_account: '5410' }),
      'user_approved',
      { bookedOnTemplateId: 'tmpl-1' },
    )
  })

  it('names no template to the learner for a category booking', async () => {
    const booked = await categorizeTransaction(ledger().supabase as never, 'user-1', COMPANY_ID, TX_ID, business, live)

    expect(booked.ok).toBe(true)
    expect(vi.mocked(upsertCounterpartyTemplate).mock.calls[0]?.[5]).toEqual({ bookedOnTemplateId: undefined })
  })
})

describe('categorizeTransaction: refusals every door shares', () => {
  it('refuses reverse charge when the pinned underlag shows the seller charged moms', async () => {
    const { supabase } = ledger({
      transactions: { data: row({ document_id: 'doc-1' }), error: null },
      document_attachments: {
        data: { id: 'doc-1', extracted_data: { totals: { total: 1250, vatAmount: 250 }, invoice: { currency: 'EUR' } } },
        error: null,
      },
    })

    const outcome = await categorizeTransaction(
      supabase as never,
      'user-1',
      COMPANY_ID,
      TX_ID,
      { ...business, vat_treatment: 'reverse_charge' },
      { onBooked: 'refuse' },
    )

    expect(outcome).toMatchObject({
      ok: false,
      code: 'TX_CATEGORIZE_REVERSE_CHARGE_SELLER_VAT',
      details: { document_id: 'doc-1', seller_vat_amount: 250 },
    })
    expect(createTxJE).not.toHaveBeenCalled()
  })

  it('refuses an account override on a private marking', async () => {
    const outcome = await categorizeTransaction(
      ledger().supabase as never,
      'user-1',
      COMPANY_ID,
      TX_ID,
      { is_business: false, account_override: '4020' },
      live,
    )

    expect(outcome).toMatchObject({ ok: false, code: 'VALIDATION_ERROR', details: { field: 'account_override' } })
    expect(createTxJE).not.toHaveBeenCalled()
  })
})

// #94: a reverse charge sent without its box at an agent or API door takes
// the box its underlag's seller and the category give, as the bulk doors do,
// and is refused when they cannot tell it. The dashboard shows the box it
// books and keeps the EU-services default.
describe('categorizeTransaction: the reverse-charge box at an agent or API door', () => {
  const software = { is_business: true, category: 'expense_software', vat_treatment: 'reverse_charge' } as const
  const api: CategorizeOptions = { onBooked: 'refuse', dryRun: true, reverseChargeBoxParam: 'reverse_charge_kind' }
  const accounts = (outcome: Awaited<ReturnType<typeof categorizeTransaction>>) =>
    outcome.ok && outcome.dryRun ? outcome.preview.lines.map((l) => l.account_number) : []
  const withDocument = (supplier: Record<string, unknown>) =>
    ledger({
      transactions: { data: row({ document_id: 'doc-1' }), error: null },
      document_attachments: { data: { id: 'doc-1', extracted_data: { supplier, totals: { total: 1250, vatAmount: 0 } } }, error: null },
    })

  it('dashboard: keeps the EU-services default the review shows', async () => {
    const outcome = await categorizeTransaction(ledger().supabase as never, 'user-1', COMPANY_ID, TX_ID, software, {
      onBooked: 'refuse',
      dryRun: true,
    })
    expect(accounts(outcome)).toContain('4535')
  })

  it('refuses when no underlag names the seller country, naming the door\'s parameter', async () => {
    const outcome = await categorizeTransaction(ledger().supabase as never, 'user-1', COMPANY_ID, TX_ID, software, api)
    expect(outcome).toMatchObject({
      ok: false,
      code: 'TX_CATEGORIZE_REVERSE_CHARGE_BOX_UNKNOWN',
      details: { reason: 'seller_country_unknown', parameter: 'reverse_charge_kind' },
    })
    if (!outcome.ok) expect(outcome.message?.sv).toMatch(/reverse_charge_kind .*"non_eu_services" \(tjänst från ett land utanför EU, ruta 22\)/)
  })

  it('books a US seller on the pinned underlag in ruta 22, not 21', async () => {
    const { supabase } = withDocument({ address: '548 Market St, San Francisco, California 94104, United States' })
    const outcome = await categorizeTransaction(supabase as never, 'user-1', COMPANY_ID, TX_ID, software, api)
    expect(accounts(outcome)).toContain('4531')
    expect(accounts(outcome)).not.toContain('4535')
    expect(outcome.ok && outcome.dryRun && outcome.preview.reverse_charge_kind).toBe('non_eu_services')
  })

  it('reads the inbox item the booking started from when the row has no document', async () => {
    const { supabase } = ledger({
      invoice_inbox_items: { data: { extracted_data: { supplier: { vatNumber: 'IE3668997OH' } }, matched_supplier_id: null }, error: null },
    })
    const outcome = await categorizeTransaction(supabase as never, 'user-1', COMPANY_ID, TX_ID, { ...software, inbox_item_id: 'item-1' }, api)
    expect(accounts(outcome)).toContain('4535')
    expect(outcome.ok && outcome.dryRun && outcome.preview.reverse_charge_kind).toBe('eu_services')
  })

  it('keeps a box the caller named, and refuses a category that says neither goods nor service', async () => {
    const named = await categorizeTransaction(ledger().supabase as never, 'user-1', COMPANY_ID, TX_ID, { ...software, reverse_charge_kind: 'eu_goods' }, api)
    expect(accounts(named)).toContain('4515')

    const { supabase } = withDocument({ vatNumber: 'IE3668997OH' })
    const other = await categorizeTransaction(supabase as never, 'user-1', COMPANY_ID, TX_ID, { ...software, category: 'expense_other' }, api)
    expect(other).toMatchObject({ ok: false, code: 'TX_CATEGORIZE_REVERSE_CHARGE_BOX_UNKNOWN', details: { reason: 'purchase_kind_unknown' } })
  })
})

describe('categorizeTransaction: the decision record', () => {
  const pass = (id: string) => ({ id, result: 'pass', detail: null })
  const recordedChecks = () => vi.mocked(recordDecisions).mock.calls[0]?.[2][0]?.checks

  it('records the guards it ran, in order, and stamps the rules version on the voucher', async () => {
    vi.mocked(snapshotSuggestions).mockResolvedValueOnce({
      companyId: COMPANY_ID,
      ruleVersion: 'bank-proposals.1+a38016f12abc',
      byTransaction: new Map(),
    })

    const outcome = await categorizeTransaction(ledger().supabase as never, 'user-1', COMPANY_ID, TX_ID, business, live)

    expect(outcome.ok).toBe(true)
    expect(createTxJE.mock.calls[0][6]).toEqual({
      rubricVersion: 'bank-proposals.1+a38016f12abc',
      // What the door tells the posting port about the decision (read only
      // while POSTING_EVENTS is shadow or strict).
      businessEvent: {
        category: 'expense_office',
        source: 'category',
        vatTreatment: null,
        linkBasis: { link_basis: 'user_created', link_evidence: null },
        inboxItemId: null,
        proposalId: null,
        templateId: null,
        counterpartyTemplateId: null,
      },
    })
    const expected = [pass('already_booked'), pass('duplicate'), pass('counter_legs'), pass('chart'), pass('period_lock')]
    expect(recordedChecks()).toEqual(expected)
    if (outcome.ok && !outcome.dryRun) expect(outcome.booked.checks).toEqual(expected)
  })

  it('records the seller-VAT check only when a reverse charge met an underlag', async () => {
    const { supabase } = ledger({
      transactions: [{ data: row({ document_id: 'doc-1' }), error: null }, { data: [row({ journal_entry_id: 'je-1' })], error: null }],
      document_attachments: { data: { id: 'doc-1', extracted_data: { totals: { total: 1250, vatAmount: 0 } } }, error: null },
    })

    await categorizeTransaction(supabase as never, 'user-1', COMPANY_ID, TX_ID, { ...business, vat_treatment: 'reverse_charge' }, live)

    expect(recordedChecks()).toContainEqual(pass('reverse_charge_seller_vat'))
  })

  it('records the invoice-match intercept where it applies, and a confirmed no-match as a warning', async () => {
    const supplierPayment = { ...business, category: 'expense_other' as const, account_override: '2440' }
    const chart = { chart_of_accounts: { data: { account_number: '2440', account_class: 2, is_active: true }, error: null } }

    await categorizeTransaction(ledger(chart).supabase as never, 'user-1', COMPANY_ID, TX_ID, supplierPayment, live)
    expect(recordedChecks()).toContainEqual({ id: 'invoice_match', result: 'pass', detail: 'supplier' })

    vi.mocked(recordDecisions).mockClear()
    await categorizeTransaction(ledger(chart).supabase as never, 'user-1', COMPANY_ID, TX_ID, { ...supplierPayment, confirm_no_match: true }, live)
    expect(recordedChecks()).toContainEqual({ id: 'invoice_match', result: 'warn', detail: 'confirm_no_match' })
  })

  it('records a duplicate booked over with force as a warning that names the candidate', async () => {
    vi.mocked(detectBookingDuplicate).mockResolvedValue({ transaction_id: null, journal_entry_id: 'je-twin' } as never)

    await categorizeTransaction(
      ledger().supabase as never,
      'user-1',
      COMPANY_ID,
      TX_ID,
      { ...business, force: true, expected_duplicate_journal_entry_id: 'je-twin' },
      live,
    )

    expect(recordedChecks()).toContainEqual({ id: 'duplicate', result: 'warn', detail: 'force:journal_entry:je-twin' })
    vi.mocked(detectBookingDuplicate).mockResolvedValue(null)
  })

  it('hands the row\'s provider identity to the duplicate guard (crm#1271)', async () => {
    const stripeRow = { external_id: 'stripe_acct_A_txn_1_fee', import_source: 'stripe', bank_connection_id: null }
    const { supabase } = ledger({
      transactions: [{ data: row(stripeRow), error: null }, { data: [row({ ...stripeRow, journal_entry_id: 'je-1' })], error: null }],
    })

    await categorizeTransaction(supabase as never, 'user-1', COMPANY_ID, TX_ID, business, live)

    expect(detectBookingDuplicate).toHaveBeenCalledWith(
      supabase,
      COMPANY_ID,
      expect.objectContaining({ id: TX_ID, ...stripeRow }),
      undefined,
    )
  })

  it("records an agent's allow_duplicate: a warning when it bypassed a candidate, a pass when there was none", async () => {
    vi.mocked(detectBookingDuplicate).mockResolvedValue({ transaction_id: 'tx-twin', journal_entry_id: null } as never)
    await categorizeTransaction(ledger().supabase as never, 'user-1', COMPANY_ID, TX_ID, { ...business, allow_duplicate: true }, { onBooked: 'refuse' })
    expect(recordedChecks()).toContainEqual({ id: 'duplicate', result: 'warn', detail: 'allow_duplicate:transaction:tx-twin' })

    vi.mocked(recordDecisions).mockClear()
    vi.mocked(detectBookingDuplicate).mockResolvedValue(null)
    await categorizeTransaction(ledger().supabase as never, 'user-1', COMPANY_ID, TX_ID, { ...business, allow_duplicate: true }, { onBooked: 'refuse' })
    expect(recordedChecks()).toContainEqual({ id: 'duplicate', result: 'pass', detail: 'allow_duplicate' })
  })
})
