/**
 * Booking an incoming payment against its customer invoice without a person
 * (crm#2226): which references count, which deposit splits count, who the
 * booking is committed as, and that a filed momsdeklaration stops a split.
 * The booking itself is bookCustomerBankMatch's (its own suite).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeInvoice } from '@/tests/helpers'
import { getActor } from '@/lib/bookkeeping/actor-context'
import { runWithActor } from '@/lib/bookkeeping/actor-context-node'
import type { BankTransactionPartInput } from '@/types'
import type { PartSuggestion } from '@/lib/transactions/part-suggestions'
import type { MatchableInvoice } from '../invoice-matching'
import { invoiceReferenceKeys } from '../ocr-keys'

const { mockBook, mockBatch, mockFiled } = vi.hoisted(() => ({
  mockBook: vi.fn(),
  mockBatch: vi.fn(),
  mockFiled: vi.fn(),
}))
vi.mock('../book-customer-bank-match', () => ({ bookCustomerBankMatch: mockBook }))
vi.mock('@/lib/transactions/match-batch', () => ({ matchTransactionBatch: mockBatch }))
vi.mock('@/lib/vat/voucher-filed-period-warning', () => ({ filedPeriodVoucherWarning: mockFiled }))

const {
  AUTO_BOOK_MATCH_METHOD,
  AUTO_BOOK_RULE_ID,
  autoBookCustomerPayment,
  autoBookSplitDeposit,
  exactReferenceSplitAllocations,
  invoiceNamedExactly,
  ocrShapedReference,
  readCustomerPaymentAutoBook,
} = await import('../customer-payment-auto-book')

const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => log } as never
const ctx = { supabase: {} as never, companyId: 'company-1', userId: 'user-1', log }

function invoice(id: string, invoiceNumber: string, overrides: Partial<MatchableInvoice> = {}): MatchableInvoice {
  return makeInvoice({ id, invoice_number: invoiceNumber, status: 'sent', total: 1000, remaining_amount: 1000, ...overrides }) as MatchableInvoice
}
const ocrOf = (invoiceNumber: string) => invoiceReferenceKeys(invoiceNumber).find((k) => k.form === 'ocr')!.key

function part(reference: string | null, amount: number, currency = 'SEK'): BankTransactionPartInput {
  return {
    amount,
    currency,
    counterparty_name: null,
    counterparty_org_number: null,
    counterparty_account: null,
    reference,
    invoice_numbers: [],
    message: null,
    provider_part_id: null,
  }
}
function suggestion(seq: number, invoiceId: string | null, reason: PartSuggestion['suggestion_reason'] = 'ocr_exact'): PartSuggestion {
  return { seq, suggested_invoice_id: invoiceId, suggested_supplier_invoice_id: null, suggestion_reason: reason }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockFiled.mockResolvedValue(null)
})

describe('ocrShapedReference', () => {
  it('reads digits, with spaces between groups, of at least four digits', () => {
    expect(ocrShapedReference('2026 0042 5')).toBe('202600425')
    expect(ocrShapedReference(' 12345 ')).toBe('12345')
  })

  it('reads a field with words or other signs as a message, not an OCR number', () => {
    expect(ocrShapedReference('Faktura 202600425')).toBeNull()
    expect(ocrShapedReference('Hyra 2026-11')).toBeNull()
    expect(ocrShapedReference('2026-11')).toBeNull()
    expect(ocrShapedReference('123')).toBeNull()
    expect(ocrShapedReference(null)).toBeNull()
  })
})

describe('invoiceNamedExactly', () => {
  const a = invoice('inv-a', '202600425')
  const b = invoice('inv-b', '202600426')

  it('names the one invoice whose printed OCR or invoice number the reference is', () => {
    expect(invoiceNamedExactly(ocrOf('202600425'), 'SEK', [a, b])?.id).toBe('inv-a')
    expect(invoiceNamedExactly('202600426', 'SEK', [a, b])?.id).toBe('inv-b')
  })

  it('names nothing in another currency, for a message, or when two invoices share the key', () => {
    expect(invoiceNamedExactly('202600425', 'EUR', [a, b])).toBeNull()
    expect(invoiceNamedExactly('Faktura 202600425', 'SEK', [a, b])).toBeNull()
    const twin = invoice('inv-twin', 'A-202600425')
    expect(invoiceNamedExactly('202600425', 'SEK', [a, twin])).toBeNull()
  })

  it('names nothing by a key too short to trust on its own', () => {
    const short = invoice('inv-short', '12')
    // The printed OCR of invoice 12 has three digits: under the floor.
    expect(invoiceNamedExactly(ocrOf('12'), 'SEK', [short])).toBeNull()
  })
})

describe('exactReferenceSplitAllocations', () => {
  const a = invoice('inv-a', '202600425', { remaining_amount: 1000 })
  const b = invoice('inv-b', '202600426', { remaining_amount: 500 })

  it('allocates each part to the invoice its OCR names', () => {
    expect(
      exactReferenceSplitAllocations(
        [part(ocrOf('202600425'), 1000), part('202600426', 400)],
        [suggestion(1, 'inv-a'), suggestion(2, 'inv-b')],
        [a, b],
      ),
    ).toEqual([
      { invoice_id: 'inv-a', amount: 1000 },
      { invoice_id: 'inv-b', amount: 400 },
    ])
  })

  it('leaves the split a suggestion when one part was matched by anything but its OCR', () => {
    expect(
      exactReferenceSplitAllocations(
        [part('202600425', 1000), part(null, 500)],
        [suggestion(1, 'inv-a'), suggestion(2, 'inv-b', 'amount_only')],
        [a, b],
      ),
    ).toBeNull()
  })

  it('leaves the split a suggestion when a part pays more than is left, or two parts name one invoice', () => {
    expect(
      exactReferenceSplitAllocations([part('202600425', 1000), part('202600426', 600)], [suggestion(1, 'inv-a'), suggestion(2, 'inv-b')], [a, b]),
    ).toBeNull()
    expect(
      exactReferenceSplitAllocations([part('202600425', 400), part('202600425', 400)], [suggestion(1, 'inv-a'), suggestion(2, 'inv-a')], [a, b]),
    ).toBeNull()
  })

  it('leaves the split a suggestion when the OCR names another invoice than the one suggested', () => {
    expect(
      exactReferenceSplitAllocations([part('202600425', 500), part('202600426', 500)], [suggestion(1, 'inv-b'), suggestion(2, 'inv-a')], [a, b]),
    ).toBeNull()
  })
})

describe('autoBookCustomerPayment', () => {
  it('books through the person\'s booking function as the system actor, with the rule as the basis', async () => {
    let actor: ReturnType<typeof getActor>
    mockBook.mockImplementation(async () => {
      actor = getActor()
      return { ok: true, journalEntryId: 'je-1' }
    })

    expect(await autoBookCustomerPayment(ctx, { id: 'tx-1' }, { id: 'inv-a' })).toMatchObject({ ok: true })

    expect(actor!).toMatchObject({ type: 'system', userId: 'user-1' })
    expect(mockBook).toHaveBeenCalledWith(ctx, {
      transactionId: 'tx-1',
      invoiceId: 'inv-a',
      overrideVia: 'auto_exact_reference',
      unattended: {
        match: { method: AUTO_BOOK_MATCH_METHOD, confidence: 0.99 },
        linkBasis: { basis: 'rule_ocr_reference', evidence: { rule_id: AUTO_BOOK_RULE_ID, score: 0.99 } },
      },
    })
  })

  it('keeps a key as the actor, so its unattended ceiling still caps the booking', async () => {
    let actor: ReturnType<typeof getActor>
    mockBook.mockImplementation(async () => {
      actor = getActor()
      return { ok: true }
    })

    await runWithActor({ type: 'api_key', label: 'key', userId: 'user-1', unattendedCommitLimit: 500 }, () =>
      autoBookCustomerPayment(ctx, { id: 'tx-1' }, { id: 'inv-a' }),
    )

    expect(actor!).toMatchObject({ type: 'api_key', unattendedCommitLimit: 500 })
  })
})

describe('autoBookSplitDeposit', () => {
  const allocations = [
    { invoice_id: 'inv-a', amount: 1000 },
    { invoice_id: 'inv-b', amount: 400 },
  ]
  const preview = {
    expected_entry_date: '2026-11-20',
    expected_lines: [
      { account_number: '1930', description: '', debit: 1400, credit: 0 },
      { account_number: '1510', description: '', debit: 0, credit: 1400 },
    ],
  }

  it('books the samlingsverifikat after its dry run passes the filed period check', async () => {
    mockBatch
      .mockResolvedValueOnce({ ok: true, dryRun: true, preview })
      .mockResolvedValueOnce({ ok: true, data: { journal_entry_id: 'je-split' } })

    expect(await autoBookSplitDeposit(ctx, { id: 'tx-1' }, allocations)).toEqual({ ok: true, journalEntryId: 'je-split' })

    const input = {
      allocations: [
        { kind: 'customer_invoice', invoice_id: 'inv-a', amount: 1000 },
        { kind: 'customer_invoice', invoice_id: 'inv-b', amount: 400 },
      ],
    }
    expect(mockBatch).toHaveBeenNthCalledWith(1, ctx, 'tx-1', input, { dryRun: true })
    expect(mockBatch).toHaveBeenNthCalledWith(2, ctx, 'tx-1', input, { via: 'auto_exact_reference' })
    expect(mockFiled).toHaveBeenCalledWith(
      ctx.supabase,
      'company-1',
      {
        entry_date: '2026-11-20',
        lines: [
          { account_number: '1930', debit_amount: 1400, credit_amount: 0 },
          { account_number: '1510', debit_amount: 0, credit_amount: 1400 },
        ],
      },
      'bank_row',
    )
  })

  it('books nothing when the verifikat would move a filed momsdeklaration', async () => {
    mockBatch.mockResolvedValueOnce({ ok: true, dryRun: true, preview })
    mockFiled.mockResolvedValueOnce({ code: 'VAT_PERIOD_ALREADY_FILED', details: { entry_date: '2026-11-20' } })

    expect(await autoBookSplitDeposit(ctx, { id: 'tx-1' }, allocations)).toMatchObject({
      ok: false,
      code: 'MATCH_INVOICE_UNATTENDED_FILED_VAT_PERIOD',
    })
    expect(mockBatch).toHaveBeenCalledTimes(1)
  })

  it('books nothing when the dry run refuses', async () => {
    mockBatch.mockResolvedValueOnce({ ok: false, code: 'BATCH_TX_POSSIBLE_DUPLICATE' })

    expect(await autoBookSplitDeposit(ctx, { id: 'tx-1' }, allocations)).toMatchObject({ ok: false, code: 'BATCH_TX_POSSIBLE_DUPLICATE' })
    expect(mockBatch).toHaveBeenCalledTimes(1)
  })
})

describe('readCustomerPaymentAutoBook', () => {
  function settings(result: { data?: unknown; error?: unknown }) {
    const query = {
      select: () => query,
      eq: () => query,
      maybeSingle: async () => result,
    }
    return { from: () => query } as never
  }

  it('is on only when the company switched it on', async () => {
    expect(await readCustomerPaymentAutoBook(settings({ data: { auto_book_customer_payments: true } }), 'c')).toBe(true)
    expect(await readCustomerPaymentAutoBook(settings({ data: { auto_book_customer_payments: false } }), 'c')).toBe(false)
    expect(await readCustomerPaymentAutoBook(settings({ data: null }), 'c')).toBe(false)
  })

  it('is off before the migration and on any failed read', async () => {
    expect(await readCustomerPaymentAutoBook(settings({ error: { code: '42703', message: 'no column' } }), 'c')).toBe(false)
    expect(await readCustomerPaymentAutoBook(settings({ error: { code: '500', message: 'down' } }), 'c')).toBe(false)
  })
})
