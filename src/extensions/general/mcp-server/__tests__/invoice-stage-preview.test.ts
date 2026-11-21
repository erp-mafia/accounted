/**
 * What the customer-invoice staging tools show before approval (agent
 * feedback seq 851670, 876823, 929266).
 *
 * gnubok_mark_invoice_as_paid used to say "booked (15xx → 19xx)" whatever the
 * company's method, so an agent on kontantmetoden read it as a receivable
 * clearing it did not have and booked the payment by hand. The preview now
 * carries the lines the executor posts. gnubok_mark_invoice_as_sent and
 * gnubok_send_invoice titled a draft "null <kund>": a draft has no number
 * until approval. They now name it by customer and amount, the number it
 * will most likely get, and whether approval posts a verifikat.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Whether a credit note is active: mocked so it takes no slot in the Supabase
// mock; the read is pinned by lib/invoices/__tests__/active-credit-note.test.ts.
const { mockHasActiveCreditNote } = vi.hoisted(() => ({ mockHasActiveCreditNote: vi.fn(async (..._args: unknown[]) => false) }))
vi.mock('@/lib/invoices/active-credit-note', () => ({ invoiceHasActiveCreditNote: mockHasActiveCreditNote }))
import { createTableMockSupabase } from '@/tests/helpers'
import { formatAmount } from '@/lib/utils'

vi.mock('@/lib/invoices/duplicate-payment-candidates', () => ({
  findDuplicatePaymentCandidatesForInvoice: vi.fn(async () => []),
}))
vi.mock('@/lib/email/service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/email/service')>()),
  getEmailService: () => ({ isConfigured: () => true }),
}))

import { tools } from '../server'

const markPaid = tools.find((t) => t.name === 'gnubok_mark_invoice_as_paid')!
const markSent = tools.find((t) => t.name === 'gnubok_mark_invoice_as_sent')!
const sendInvoice = tools.find((t) => t.name === 'gnubok_send_invoice')!

const INVOICE_ID = '33333333-3333-4333-8333-333333333333'

function sentInvoice(overrides: Record<string, unknown> = {}) {
  return {
    id: INVOICE_ID,
    invoice_number: 'F-1001',
    status: 'sent',
    document_type: 'invoice',
    credited_invoice_id: null,
    journal_entry_id: null,
    payment_cash_account_id: null,
    total: 12500,
    total_sek: 12500,
    subtotal: 10000,
    subtotal_sek: 10000,
    vat_amount: 2500,
    vat_amount_sek: 2500,
    currency: 'SEK',
    exchange_rate: null,
    vat_treatment: 'standard_25',
    paid_amount: 0,
    remaining_amount: 12500,
    customer: { name: 'Testkund AB', email: 'ekonomi@example.com', address_line1: 'Storgatan 1', postal_code: '111 22', city: 'Stockholm', country: 'SE' },
    ...overrides,
  }
}

// A faktura names its seller (ML 17 kap 24 § p.5, crm#2080).
const SELLER = { company_name: 'Test AB', address_line1: 'Testgatan 1', postal_code: '111 22', city: 'Stockholm' }

const ITEM = {
  id: 'item-1',
  invoice_id: INVOICE_ID,
  sort_order: 0,
  line_type: 'product',
  description: 'Konsulttjänst',
  quantity: 1,
  unit: 'st',
  unit_price: 10000,
  line_total: 10000,
  vat_rate: 25,
  vat_amount: 2500,
  revenue_account: null,
}

function setup(settings: Record<string, unknown>, invoice: Record<string, unknown>) {
  const mock = createTableMockSupabase({
    invoices: { data: invoice },
    invoice_items: { data: [ITEM] },
    company_settings: {
      data: { entity_type: 'enskild_firma', bookkeeping_locked_through: null, ...SELLER, ...settings },
    },
    fiscal_periods: { data: { id: 'fp-1', is_closed: false, locked_at: null } },
    pending_operations: { data: { id: 'op-1' } },
    'rpc:peek_next_invoice_number': { data: 'F-1042' },
  })
  return mock
}

function stagedInsert(findCall: (t: string, m: string) => unknown[] | undefined) {
  const args = findCall('pending_operations', 'insert')
  expect(args).toBeDefined()
  return args![0] as { title: string; preview_data: Record<string, unknown> }
}

type PreviewLine = { account_number: string; debit_amount: number; credit_amount: number }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('gnubok_mark_invoice_as_paid: the preview shows the entry the method books', () => {
  // #1717: a partially_paid invoice is payable on every door, as on the
  // dashboard; the remaining amount clears 1510.
  it('stages a partially_paid invoice for its remaining amount', async () => {
    const { supabase, findCall } = setup(
      { accounting_method: 'accrual' },
      sentInvoice({ status: 'partially_paid', journal_entry_id: 'je-issue', paid_amount: 5000, remaining_amount: 7500 }),
    )

    const result = (await markPaid.execute(
      { invoice_id: INVOICE_ID, payment_date: '2026-09-15' },
      'company-1', 'user-1', supabase as never, { type: 'api_key' } as never,
    )) as { staged: boolean; preview: Record<string, unknown> }

    expect(result.staged).toBe(true)
    const entry = result.preview.journal_entry_preview as { lines: PreviewLine[] }
    const byAccount = Object.fromEntries(entry.lines.map((l) => [l.account_number, l]))
    expect(byAccount['1510']).toMatchObject({ debit_amount: 0, credit_amount: 7500 })
    expect(stagedInsert(findCall)).toBeDefined()
  })

  it.each(['paid', 'credited', 'draft'])('refuses a %s invoice at staging', async (status) => {
    const { supabase } = setup({ accounting_method: 'accrual' }, sentInvoice({ status }))
    await expect(
      markPaid.execute(
        { invoice_id: INVOICE_ID, payment_date: '2026-09-15' },
        'company-1', 'user-1', supabase as never, { type: 'api_key' } as never,
      ),
    ).rejects.toMatchObject({ code: 'INVOICE_PAID_NOT_PAYABLE' })
  })

  it('refuses at staging what approval would refuse: a credit note draft, a följesedel, a date ahead of today', async () => {
    const stage = (invoice: Record<string, unknown>, paymentDate = '2026-09-15') =>
      markPaid.execute(
        { invoice_id: INVOICE_ID, payment_date: paymentDate },
        'company-1', 'user-1', setup({ accounting_method: 'accrual' }, invoice).supabase as never, { type: 'api_key' } as never,
      )

    mockHasActiveCreditNote.mockResolvedValueOnce(true)
    await expect(stage(sentInvoice())).rejects.toMatchObject({ code: 'INVOICE_PAID_NOT_PAYABLE' })
    await expect(stage(sentInvoice({ document_type: 'delivery_note' }))).rejects.toMatchObject({ code: 'INVOICE_PAID_NOT_PAYABLE' })
    await expect(stage(sentInvoice(), '2099-01-01')).rejects.toMatchObject({ code: 'PAYMENT_DATE_IN_FUTURE' })
  })

  it('kontantmetoden, unbooked SEK invoice: bank debit, revenue and output VAT credit, no 1510', async () => {
    const { supabase, findCall } = setup({ accounting_method: 'cash' }, sentInvoice())

    const result = (await markPaid.execute(
      { invoice_id: INVOICE_ID, payment_date: '2026-09-15' },
      'company-1', 'user-1', supabase as never, { type: 'api_key' } as never,
    )) as { preview: Record<string, unknown>; next?: { description: string } }

    const preview = result.preview
    expect(preview.accounting_method).toBe('cash')
    expect(preview.source_type).toBe('invoice_cash_payment')
    const entry = preview.journal_entry_preview as { lines: PreviewLine[]; total_debit: number; total_credit: number }
    const byAccount = Object.fromEntries(entry.lines.map((l) => [l.account_number, l]))
    expect(byAccount['1930']).toMatchObject({ debit_amount: 12500, credit_amount: 0 })
    expect(byAccount['3001']).toMatchObject({ debit_amount: 0, credit_amount: 10000 })
    expect(byAccount['2611']).toMatchObject({ debit_amount: 0, credit_amount: 2500 })
    expect(byAccount['1510']).toBeUndefined()
    expect(entry.total_debit).toBe(12500)
    expect(entry.total_credit).toBe(12500)

    expect(result.next?.description).toContain('kontantmetoden')
    expect(result.next?.description).not.toContain('15xx')
    // The persisted approval card carries the same lines.
    expect(stagedInsert(findCall).preview_data.journal_entry_preview).toEqual(entry)
  })

  it('a foreign invoice previews what 1510 carries, as approval clears it', async () => {
    // 141.36 + 35.34 EUR at 11.123 registered 1965.44; the header at the rate says 1965.43.
    const { supabase, setTable } = setup(
      { accounting_method: 'accrual' },
      sentInvoice({
        journal_entry_id: 'je-issue',
        currency: 'EUR',
        exchange_rate: 11.123,
        total: 176.7,
        total_sek: 1965.43,
        remaining_amount: 176.7,
      }),
    )
    setTable('rpc:document_carried_sek', { data: { ok: true, sek: 1965.44 } })

    const result = (await markPaid.execute(
      { invoice_id: INVOICE_ID, payment_date: '2026-09-15' },
      'company-1', 'user-1', supabase as never, { type: 'api_key' } as never,
    )) as { preview: { journal_entry_preview: { lines: PreviewLine[] } } }

    const byAccount = Object.fromEntries(result.preview.journal_entry_preview.lines.map((l) => [l.account_number, l]))
    expect(byAccount['1510']).toMatchObject({ credit_amount: 1965.44 })
    expect(byAccount['1930']).toMatchObject({ debit_amount: 1965.44 })
  })

  it('faktureringsmetoden: the payment clears 1510', async () => {
    const { supabase } = setup({ accounting_method: 'accrual' }, sentInvoice({ journal_entry_id: 'je-issue' }))

    const result = (await markPaid.execute(
      { invoice_id: INVOICE_ID, payment_date: '2026-09-15' },
      'company-1', 'user-1', supabase as never, { type: 'api_key' } as never,
    )) as { preview: Record<string, unknown>; next?: { description: string } }

    expect(result.preview.accounting_method).toBe('accrual')
    expect(result.preview.source_type).toBe('invoice_paid')
    const entry = result.preview.journal_entry_preview as { lines: PreviewLine[] }
    expect(entry.lines).toEqual([
      expect.objectContaining({ account_number: '1930', debit_amount: 12500, credit_amount: 0 }),
      expect.objectContaining({ account_number: '1510', debit_amount: 0, credit_amount: 12500 }),
    ])
    expect(result.next?.description).toContain('1510')
  })

  it('kontantmetoden, invoice already booked at issue: clears 1510 like the executor', async () => {
    const { supabase, findCalls } = setup({ accounting_method: 'cash' }, sentInvoice({ journal_entry_id: 'je-issue' }))

    const result = (await markPaid.execute(
      { invoice_id: INVOICE_ID, payment_date: '2026-09-15' },
      'company-1', 'user-1', supabase as never, { type: 'api_key' } as never,
    )) as { preview: Record<string, unknown> }

    expect(result.preview.accounting_method).toBe('accrual')
    const entry = result.preview.journal_entry_preview as { lines: PreviewLine[] }
    expect(entry.lines.map((l) => l.account_number)).toEqual(['1930', '1510'])
    // The 1510 clearing needs no invoice rows.
    expect(findCalls('invoice_items', 'select')).toHaveLength(0)
  })
})

describe('gnubok_mark_invoice_as_paid: the preview follows the executor, not a proposal', () => {
  async function stage(settings: Record<string, unknown>, invoice: Record<string, unknown>, items?: unknown[]) {
    const mock = setup(settings, invoice)
    if (items) mock.setTable('invoice_items', { data: items })
    const result = (await markPaid.execute(
      { invoice_id: INVOICE_ID, payment_date: '2026-09-15' },
      'company-1', 'user-1', mock.supabase as never, { type: 'api_key' } as never,
    )) as { preview: Record<string, unknown>; next?: { description: string } }
    return { result, lines: (result.preview.journal_entry_preview as { lines: PreviewLine[] }).lines }
  }

  it('an öre remainder is booked bank against 1510, as the executor does, never a 3740 write-off', async () => {
    const { lines } = await stage(
      { accounting_method: 'accrual' },
      sentInvoice({ journal_entry_id: 'je-issue', paid_amount: 12499.6, remaining_amount: 0.4 }),
    )
    expect(lines).toEqual([
      expect.objectContaining({ account_number: '1930', debit_amount: 0.4, credit_amount: 0 }),
      expect.objectContaining({ account_number: '1510', debit_amount: 0, credit_amount: 0.4 }),
    ])
  })

  it('a reverse-charge cash entry names only the accounts it touches (no 26xx)', async () => {
    const { result, lines } = await stage(
      { accounting_method: 'cash' },
      sentInvoice({ vat_treatment: 'reverse_charge', vat_amount: 0, vat_amount_sek: 0, total: 10000, total_sek: 10000, remaining_amount: 10000 }),
      [{ ...ITEM, vat_rate: 0, vat_amount: 0 }],
    )
    expect(lines.map((l) => l.account_number)).toEqual(['1930', '3308'])
    expect(result.next?.description).toContain('debit 1930 / credit 3308')
    expect(result.next?.description).not.toMatch(/26\d\d/)
  })

  it("a kontantmetod ROT cash entry books the customer's share only: Skatteverket's share waits for the payout", async () => {
    const { result, lines } = await stage(
      { accounting_method: 'cash' },
      sentInvoice({ deduction_total: 3750, remaining_amount: 8750 }),
      [{ ...ITEM, deduction_type: 'rot', deduction_amount: 3750 }],
    )
    expect(lines.map((l) => l.account_number)).not.toContain('1513')
    expect(lines.find((l) => l.account_number === '1930')?.debit_amount).toBe(8750)
    expect(result.next?.description).toMatch(/debit 1930 \/ credit/)
  })
})

describe('gnubok_mark_invoice_as_sent / gnubok_send_invoice: a draft without a number', () => {
  const draft = () => sentInvoice({ status: 'draft', invoice_number: null, total: 4321.5 })

  it('titles the draft by customer and amount, never "null", with the expected number', async () => {
    const { supabase, findCall } = setup({ accounting_method: 'accrual', defer_invoice_booking: false }, draft())

    const result = (await markSent.execute(
      { invoice_id: INVOICE_ID }, 'company-1', 'user-1', supabase as never, { type: 'api_key' } as never,
    )) as { preview: Record<string, unknown> }

    const { title } = stagedInsert(findCall)
    expect(title).not.toContain('null')
    expect(title).toBe(`Markera skickad: Testkund AB, ${formatAmount(4321.5)} SEK (förväntat nr F-1042)`)
    expect(result.preview.will_post_journal_entry).toBe(true)
    expect(result.preview.expected_invoice_number).toBe('F-1042')
    expect(result.preview.expected_invoice_number_note).toContain('not reserved')
    expect(findCall('rpc:peek_next_invoice_number', 'rpc')?.[0]).toEqual({
      p_company_id: 'company-1',
      p_document_type: 'invoice',
    })
  })

  it('deferred booking: approval posts no verifikat', async () => {
    const { supabase } = setup({ accounting_method: 'accrual', defer_invoice_booking: true }, draft())

    const result = (await markSent.execute(
      { invoice_id: INVOICE_ID }, 'company-1', 'user-1', supabase as never, { type: 'api_key' } as never,
    )) as { preview: Record<string, unknown> }

    expect(result.preview.will_post_journal_entry).toBe(false)
  })

  it('kontantmetoden: approval posts no verifikat (booked at payment)', async () => {
    const { supabase } = setup({ accounting_method: 'cash' }, draft())

    const result = (await markSent.execute(
      { invoice_id: INVOICE_ID }, 'company-1', 'user-1', supabase as never, { type: 'api_key' } as never,
    )) as { preview: Record<string, unknown> }

    expect(result.preview.will_post_journal_entry).toBe(false)
  })

  it('leaves the number out of the title when it cannot be peeked', async () => {
    const { supabase, setTable, findCall } = setup({ accounting_method: 'accrual' }, draft())
    setTable('rpc:peek_next_invoice_number', { data: null, error: { message: 'boom' } })

    const result = (await markSent.execute(
      { invoice_id: INVOICE_ID }, 'company-1', 'user-1', supabase as never, { type: 'api_key' } as never,
    )) as { preview: Record<string, unknown> }

    expect(stagedInsert(findCall).title).toBe(`Markera skickad: Testkund AB, ${formatAmount(4321.5)} SEK`)
    expect(result.preview.expected_invoice_number).toBeNull()
  })

  it('keeps the number in the title once the draft has one', async () => {
    const { supabase, findCall } = setup({ accounting_method: 'accrual' }, sentInvoice({ status: 'draft', invoice_number: 'F-007' }))

    await markSent.execute(
      { invoice_id: INVOICE_ID }, 'company-1', 'user-1', supabase as never, { type: 'api_key' } as never,
    )

    expect(stagedInsert(findCall).title).toBe('Markera skickad: F-007 Testkund AB')
    expect(findCall('rpc:peek_next_invoice_number', 'rpc')).toBeUndefined()
  })

  it('send_invoice titles the draft the same way', async () => {
    const { supabase, findCall } = setup({ accounting_method: 'accrual', defer_invoice_booking: false }, draft())

    const result = (await sendInvoice.execute(
      { invoice_id: INVOICE_ID }, 'company-1', 'user-1', supabase as never, { type: 'api_key' } as never,
    )) as { preview: Record<string, unknown> }

    const { title } = stagedInsert(findCall)
    expect(title).not.toContain('null')
    expect(title).toBe(`Skicka: Testkund AB, ${formatAmount(4321.5)} SEK (förväntat nr F-1042) till ekonomi@example.com`)
    expect(result.preview.will_post_journal_entry).toBe(true)
  })
})

// crm#1281: the kontantfaktura over MCP. paid_at_issue_account stages the
// dashboard's "issued already paid": one cash verifikat on the invoice date in
// either method, refused at staging by the rule the approval applies.
describe('gnubok_mark_invoice_as_sent with paid_at_issue_account (crm#1281)', () => {
  const draft = (overrides: Record<string, unknown> = {}) =>
    sentInvoice({ status: 'draft', invoice_number: null, invoice_date: '2026-10-17', ...overrides })

  it.each(['accrual', 'cash'])('%s: stages the paid issue with the cash verifikat it books, no 1510', async (method) => {
    const { supabase, findCall } = setup({ accounting_method: method, defer_invoice_booking: false }, draft())

    const result = (await markSent.execute(
      { invoice_id: INVOICE_ID, paid_at_issue_account: '1930' },
      'company-1', 'user-1', supabase as never, { type: 'api_key' } as never,
    )) as { staged: boolean; preview: Record<string, unknown>; next?: { description: string; tool?: string } }

    expect(result.staged).toBe(true)
    const staged = stagedInsert(findCall) as { title: string; params: Record<string, unknown>; preview_data: Record<string, unknown> }
    expect(staged.title).toBe(`Utfärda betald (1930): Testkund AB, ${formatAmount(12500)} SEK (förväntat nr F-1042)`)
    expect(staged.params).toEqual({ invoice_id: INVOICE_ID, paid_at_issue: { account_number: '1930' } })

    expect(result.preview).toMatchObject({
      will_post_journal_entry: true,
      will_be_fully_paid: true,
      voucher_date: '2026-10-17',
      paid_at_issue_account: '1930',
    })
    const entry = result.preview.journal_entry_preview as { lines: PreviewLine[]; total_debit: number; total_credit: number }
    const byAccount = Object.fromEntries(entry.lines.map((l) => [l.account_number, l]))
    expect(byAccount['1930']).toMatchObject({ debit_amount: 12500, credit_amount: 0 })
    expect(byAccount['2611']).toMatchObject({ debit_amount: 0, credit_amount: 2500 })
    expect(byAccount['1510']).toBeUndefined()
    expect(entry.total_debit).toBe(entry.total_credit)
    expect(result.next?.description).toContain('already paid')
    expect(result.next?.tool).toBe('gnubok_get_ar_ledger')
    // The verifikat's date is checked against the period, as for mark paid.
    expect(result.preview.period_status).toBeDefined()
  })

  it.each(['1510', '3001', '19', 'abcd'])('refuses %s as the payment account before anything is read', async (account) => {
    const { supabase, findCall } = setup({ accounting_method: 'accrual' }, draft())

    await expect(
      markSent.execute(
        { invoice_id: INVOICE_ID, paid_at_issue_account: account },
        'company-1', 'user-1', supabase as never, { type: 'api_key' } as never,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(findCall('invoices', 'select')).toBeUndefined()
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
  })

  it.each([
    ['not_invoice', { document_type: 'proforma' }, [ITEM]],
    ['self_billed', { is_self_billed: true }, [ITEM]],
    ['periodisering', {}, [{ ...ITEM, accrual_period_start: '2026-11-01', accrual_period_end: '2027-10-31' }]],
    ['dated_ahead', { invoice_date: '2099-01-01' }, [ITEM]],
  ])('refuses %s at staging with INVOICE_PAID_AT_ISSUE_NOT_ALLOWED', async (reason, overrides, items) => {
    const { supabase, setTable, findCall } = setup({ accounting_method: 'accrual' }, draft(overrides))
    setTable('invoice_items', { data: items })

    const error = (await markSent
      .execute(
        { invoice_id: INVOICE_ID, paid_at_issue_account: '1930' },
        'company-1', 'user-1', supabase as never, { type: 'api_key' } as never,
      )
      .catch((err: unknown) => err)) as { code?: string; message?: string; remediation?: { tool?: string } } | undefined

    expect(error).toMatchObject({ code: 'INVOICE_PAID_AT_ISSUE_NOT_ALLOWED' })
    expect(error?.message).toContain(reason)
    expect(error?.remediation?.tool).toBe('gnubok_mark_invoice_as_sent')
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
  })
})

// crm#2080: the seller's and the buyer's name and address (ML 17 kap 24 §
// p.5-6), refused at staging by the verdict the approval's issuable gives.
describe('gnubok_mark_invoice_as_sent / gnubok_send_invoice: names and addresses (crm#2080)', () => {
  const nameOnly = { name: 'Testkund AB', email: 'ekonomi@example.com', address_line1: null, postal_code: null, city: null, country: 'SE' }
  const run = (tool: typeof markSent, supabase: unknown) =>
    tool.execute({ invoice_id: INVOICE_ID }, 'company-1', 'user-1', supabase as never, { type: 'api_key' } as never)

  it('refuses a company without an address and stages nothing', async () => {
    for (const tool of [markSent, sendInvoice]) {
      const { supabase, findCall } = setup({ accounting_method: 'accrual', address_line1: null, postal_code: null, city: null }, sentInvoice({ status: 'draft', invoice_number: null }))
      await expect(run(tool, supabase)).rejects.toMatchObject({ code: 'INVOICE_SEND_SELLER_ADDRESS_MISSING' })
      expect(findCall('pending_operations', 'insert')).toBeUndefined()
    }
  })

  it('refuses a buyer without an address over 4 000 kr and stages nothing', async () => {
    for (const tool of [markSent, sendInvoice]) {
      const { supabase, findCall } = setup({ accounting_method: 'accrual' }, sentInvoice({ status: 'draft', invoice_number: null, customer: nameOnly }))
      await expect(run(tool, supabase)).rejects.toMatchObject({ code: 'INVOICE_SEND_BUYER_ADDRESS_MISSING' })
      expect(findCall('pending_operations', 'insert')).toBeUndefined()
    }
  })

  it('stages a förenklad faktura without the buyer address with the note', async () => {
    for (const tool of [markSent, sendInvoice]) {
      const { supabase, findCall } = setup(
        { accounting_method: 'accrual' },
        sentInvoice({ status: 'draft', invoice_number: null, total: 1250, total_sek: 1250, customer: nameOnly }),
      )
      await run(tool, supabase)
      expect(String(stagedInsert(findCall).preview_data.compliance_warning)).toContain('BUYER_ADDRESS_MISSING')
    }
  })
})

// crm#1202: sending a quote sends the quote. It books nothing even under
// faktureringsmetoden, and its next step is the customer's answer, never a
// payment.
describe('gnubok_send_invoice: a delivery note', () => {
  it('is refused at staging by the rule the approval applies: it is marked sent, never emailed', async () => {
    const { supabase } = setup(
      { accounting_method: 'accrual', defer_invoice_booking: false },
      sentInvoice({ status: 'draft', invoice_number: 'D-1', document_type: 'delivery_note' }),
    )

    await expect(
      sendInvoice.execute({ invoice_id: INVOICE_ID }, 'company-1', 'user-1', supabase as never, { type: 'api_key' } as never),
    ).rejects.toMatchObject({ code: 'INVOICE_SEND_DELIVERY_NOTE' })
  })
})

describe('gnubok_send_invoice: a quote', () => {
  it('stages the quote with no verifikat and points at the decision, not at payment', async () => {
    const { supabase, findCall } = setup(
      { accounting_method: 'accrual', defer_invoice_booking: false },
      sentInvoice({ status: 'draft', invoice_number: 'OF-001', document_type: 'quote', quote_status: 'open' }),
    )

    const result = (await sendInvoice.execute(
      { invoice_id: INVOICE_ID }, 'company-1', 'user-1', supabase as never, { type: 'api_key' } as never,
    )) as { preview: Record<string, unknown>; next: { tool: string; description: string; args: Record<string, unknown> } }

    expect(stagedInsert(findCall).title).toBe('Skicka: OF-001 till ekonomi@example.com')
    expect(result.preview.will_post_journal_entry).toBe(false)
    expect(result.next.tool).toBe('gnubok_set_quote_status')
    expect(result.next.args).toMatchObject({ invoice_id: INVOICE_ID })
    expect(result.next.description).toContain('gnubok_convert_invoice')
  })

  it('still points a faktura at payment', async () => {
    const { supabase } = setup(
      { accounting_method: 'accrual', defer_invoice_booking: false },
      sentInvoice({ status: 'draft', invoice_number: 'F-007' }),
    )

    const result = (await sendInvoice.execute(
      { invoice_id: INVOICE_ID }, 'company-1', 'user-1', supabase as never, { type: 'api_key' } as never,
    )) as { next: { tool: string } }

    expect(result.next.tool).toBe('gnubok_mark_invoice_as_paid')
  })
})
