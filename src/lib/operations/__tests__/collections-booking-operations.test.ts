/**
 * The collections booking operations: what they read, what a dry run
 * previews without writing, what a staged payout booking pins and refuses
 * once the payout changed, and how they hand the person (the approver or
 * the key's user) to the booking services.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { z } from 'zod'

const mocks = vi.hoisted(() => ({
  loadSettlementsOverview: vi.fn(),
  loadSettlementDetail: vi.fn(),
  chooseSettlementLineAccounts: vi.fn(),
  bookSettlement: vi.fn(),
  loadSettlementLines: vi.fn(),
  previewSettlementVoucher: vi.fn(),
  bookCollectedPayment: vi.fn(),
  loadCollectedPayment: vi.fn(),
  previewCollectedPayment: vi.fn(),
}))

vi.mock('@/lib/collections/settlements-view', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/collections/settlements-view')>()),
  loadSettlementsOverview: mocks.loadSettlementsOverview,
  loadSettlementDetail: mocks.loadSettlementDetail,
  chooseSettlementLineAccounts: mocks.chooseSettlementLineAccounts,
}))
vi.mock('@/lib/collections/settlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/collections/settlements')>()),
  bookSettlement: mocks.bookSettlement,
  loadSettlementLines: mocks.loadSettlementLines,
  previewSettlementVoucher: mocks.previewSettlementVoucher,
}))
vi.mock('@/lib/collections/collected-payments', () => ({
  bookCollectedPayment: mocks.bookCollectedPayment,
  loadCollectedPayment: mocks.loadCollectedPayment,
  previewCollectedPayment: mocks.previewCollectedPayment,
}))
const serviceClient = { from: vi.fn() }
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => serviceClient }))

import {
  COLLECTIONS_BOOKING_OPERATION_LIST,
  collectionsPaymentsBook,
  collectionsSettlementsBook,
  collectionsSettlementsList,
  settlementMatchesPin,
} from '../collections-booking'

const SETTLEMENT_ID = '5c1e2f3a-4b5c-4d6e-8f70-819203a4b5c6'
const PAYMENT_ID = '8a2b2f3a-4b5c-4d6e-8f70-819203a4b5c6'

function ctx() {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { supabase: { caller: true } as never, companyId: 'company-1', userId: 'user-1', log: log as never }
}

function lineRow(position: number, kind: string, extra: Record<string, unknown> = {}) {
  return {
    id: `line-${position}`,
    position,
    kind,
    in_payout: true,
    recipient: 'agency',
    amount: 100,
    tax_amount: 0,
    account_number: null,
    vat_account_number: null,
    account_chosen_by: null,
    ...extra,
  }
}

function detail(extra: Record<string, unknown> = {}) {
  return {
    id: SETTLEMENT_ID,
    providerSettlementRef: '7731',
    paymentDate: '2026-10-01',
    amount: 843.75,
    status: 'needs_mapping',
    needsMappingReason: 'vat_unconfirmed',
    duplicateOf: null,
    lines: [],
    ...extra,
  }
}

const LINES = [lineRow(0, 'principal', { amount: 1000, account_number: '1689', recipient: 'creditor' }), lineRow(1, 'agency_fee_vat', { amount: 31.25 })]

/** The planner's voucher for LINES with 2641 for the VAT (a commission line left out for brevity). */
function okPlan(vatAccount = '2641') {
  return {
    ok: true,
    lines: [
      { account_number: '1930', debit_amount: 968.75, credit_amount: 0 },
      { account_number: vatAccount, debit_amount: 31.25, credit_amount: 0 },
      { account_number: '1689', debit_amount: 0, credit_amount: 1000 },
    ],
    lineAccounts: [
      { position: 0, account: '1689', vatAccount: null, suggestedAccount: null, booked: true },
      { position: 1, account: vatAccount, vatAccount: null, suggestedAccount: null, booked: true },
    ],
    settles: ['cp-1'],
    credits: 1000,
    debits: 1000,
  }
}
const VOUCHER = [
  { account_number: '1930', debit: 968.75, credit: 0 },
  { account_number: '2641', debit: 31.25, credit: 0 },
  { account_number: '1689', debit: 0, credit: 1000 },
]
const PINNED_LINES = [
  { position: 0, kind: 'principal', amount: 1000, tax_amount: 0 },
  { position: 1, kind: 'agency_fee_vat', amount: 31.25, tax_amount: 0 },
]

beforeEach(() => {
  vi.clearAllMocks()
  mocks.loadSettlementDetail.mockResolvedValue(detail())
  mocks.loadSettlementLines.mockResolvedValue(LINES)
  mocks.chooseSettlementLineAccounts.mockResolvedValue({ ok: true, changed: 1 })
  mocks.bookSettlement.mockResolvedValue({ ok: true, journalEntryId: 'je-d1', alreadyBooked: false, acknowledged: true })
  mocks.previewSettlementVoucher.mockImplementation(async (_deps: unknown, _company: string, _id: string, choices: { accountNumber?: string }[]) =>
    okPlan(choices[0]?.accountNumber ?? '2641'),
  )
})

describe('output schemas', () => {
  it('qualify every identifier (no bare id), as the MCP tool rules require', () => {
    const bare: string[] = []
    const walk = (schema: unknown, path: string) => {
      if (!schema || typeof schema !== 'object') return
      const node = schema as { properties?: Record<string, unknown>; items?: unknown; anyOf?: unknown[] }
      if (node.properties) {
        if ('id' in node.properties) bare.push(path)
        for (const [key, value] of Object.entries(node.properties)) walk(value, `${path}.${key}`)
      }
      if (node.items) walk(node.items, `${path}[]`)
      for (const option of node.anyOf ?? []) walk(option, path)
    }
    for (const op of COLLECTIONS_BOOKING_OPERATION_LIST) walk(z.toJSONSchema(op.output as z.ZodTypeAny, { io: 'output', unrepresentable: 'any' }), op.id)
    expect(bare).toEqual([])
  })
})

describe('collections.settlements.list', () => {
  it('reads the overview with the caller\'s own client, and one payout with its lines, every id qualified', async () => {
    const item = {
      id: SETTLEMENT_ID,
      providerSettlementRef: '7731',
      paymentDate: '2026-10-01',
      amount: 843.75,
      currency: 'SEK',
      status: 'received',
      needsMappingReason: null,
      journalEntryId: null,
      voucher: null,
      bankReference: 'PAYOUT 7731',
      acknowledged: false,
      duplicateCleared: false,
      ignoredReason: null,
    }
    mocks.loadSettlementsOverview.mockResolvedValue({
      provider: 'Acme Inkasso',
      settlements: [item],
      collectedPayments: [
        {
          id: PAYMENT_ID,
          caseId: 'case-1',
          invoiceId: 'inv-1',
          invoiceNumber: '1042',
          customerName: 'Kund AB',
          paidAt: '2026-09-27',
          capitalPaid: 1000,
          toAgency: 0,
          status: 'pending',
          reviewReason: null,
          journalEntryId: null,
          voucher: null,
          settlementId: null,
        },
      ],
    })
    mocks.loadSettlementDetail.mockResolvedValue({
      ...item,
      settlementDate: '2026-10-01',
      providerStatusOk: true,
      documentAttachmentId: null,
      duplicateOf: null,
      lines: [
        {
          position: 0,
          kind: 'principal',
          inPayout: true,
          amount: 1000,
          taxAmount: 0,
          accountNumber: '1689',
          vatAccountNumber: null,
          chosenByPerson: false,
          needsAccount: null,
          needsVatAccount: false,
        },
      ],
      voucherPreview: [{ accountNumber: '1930', debit: 1000, credit: 0 }],
    })
    const c = ctx()
    const outcome = await collectionsSettlementsList.run(c, { settlement_id: SETTLEMENT_ID }, { dryRun: false })
    expect(outcome.ok).toBe(true)
    const data = (outcome as { data: Record<string, unknown> }).data
    expect(collectionsSettlementsList.output.safeParse(data).success).toBe(true)
    expect(data).toMatchObject({
      provider: 'Acme Inkasso',
      settlements: [{ settlement_id: SETTLEMENT_ID, provider_settlement_ref: '7731', needs_mapping_reason: null }],
      collected_payments: [{ collected_payment_id: PAYMENT_ID, case_id: 'case-1', invoice_id: 'inv-1', capital_paid: 1000, settlement_id: null }],
      settlement: {
        settlement_id: SETTLEMENT_ID,
        lines: [{ position: 0, account_number: '1689', needs_account: null, needs_vat_account: false }],
        voucher_preview: [{ account_number: '1930', debit: 1000, credit: 0 }],
      },
    })
    // No bare id anywhere (the MCP rule for output schemas).
    expect(JSON.stringify(data)).not.toMatch(/"id":/)
    expect(mocks.loadSettlementsOverview).toHaveBeenCalledWith(c.supabase, 'company-1')
    expect(mocks.loadSettlementDetail).toHaveBeenCalledWith(c.supabase, 'company-1', SETTLEMENT_ID)
  })

  it('answers 404 for a payout the company does not have', async () => {
    mocks.loadSettlementsOverview.mockResolvedValue({ provider: null, settlements: [], collectedPayments: [] })
    mocks.loadSettlementDetail.mockResolvedValue(null)
    expect(await collectionsSettlementsList.run(ctx(), { settlement_id: SETTLEMENT_ID }, { dryRun: false })).toEqual({
      ok: false,
      code: 'COLLECTION_SETTLEMENT_NOT_FOUND',
    })
  })
})

describe('collections.payments.book', () => {
  const PAYMENT_ROW = { id: PAYMENT_ID, invoice_id: 'inv-1', paid_at: '2026-09-27', capital_paid: 1000, status: 'pending' }

  it('previews the invoice and the clearing account without booking, and pins the payment day at staging', async () => {
    mocks.previewCollectedPayment.mockResolvedValue({ row: PAYMENT_ROW, invoiceNumber: '1042', clearingAccount: '1689' })
    const outcome = await collectionsPaymentsBook.run(ctx(), { collected_payment_id: PAYMENT_ID }, { dryRun: true })
    expect(outcome).toMatchObject({
      ok: true,
      dryRun: true,
      preview: { invoice_number: '1042', clearing_account: '1689', paid_at: '2026-09-27', capital_paid: 1000, already_booked: false },
    })
    expect(mocks.bookCollectedPayment).not.toHaveBeenCalled()
    const preview = (outcome as { preview: Record<string, unknown> }).preview
    const pinned = collectionsPaymentsBook.mcp!.stage!.pinParams!({ collected_payment_id: PAYMENT_ID }, preview)
    expect(pinned).toEqual({ collected_payment_id: PAYMENT_ID, payment_date: '2026-09-27' })
    expect(collectionsPaymentsBook.input.safeParse(pinned).success).toBe(true)
  })

  it('refuses at commit a payment whose day is not the one approved', async () => {
    mocks.loadCollectedPayment.mockResolvedValue({ ...PAYMENT_ROW, paid_at: '2026-09-28' })
    expect(await collectionsPaymentsBook.run(ctx(), { collected_payment_id: PAYMENT_ID, payment_date: '2026-09-27' }, { dryRun: false })).toEqual({
      ok: false,
      code: 'COLLECTED_PAYMENT_CHANGED',
    })
    expect(mocks.bookCollectedPayment).not.toHaveBeenCalled()
  })

  it('refuses a payment it cannot find or that is ignored', async () => {
    mocks.previewCollectedPayment.mockResolvedValue(null)
    expect(await collectionsPaymentsBook.run(ctx(), { collected_payment_id: PAYMENT_ID }, { dryRun: true })).toEqual({ ok: false, code: 'COLLECTED_PAYMENT_NOT_FOUND' })
    mocks.bookCollectedPayment.mockResolvedValue({ ok: false, outcome: 'ignored' })
    expect(await collectionsPaymentsBook.run(ctx(), { collected_payment_id: PAYMENT_ID }, { dryRun: false })).toEqual({ ok: false, code: 'COLLECTED_PAYMENT_IGNORED' })
  })

  it('books as the person behind the call, and answers a refusal by the books as needs_review', async () => {
    mocks.bookCollectedPayment.mockResolvedValueOnce({ ok: true, journalEntryId: 'je-c1', invoicePaymentId: 'ip-1', alreadyBooked: false })
    expect(await collectionsPaymentsBook.run(ctx(), { collected_payment_id: PAYMENT_ID }, { dryRun: false })).toEqual({
      ok: true,
      data: { outcome: 'booked', journal_entry_id: 'je-c1', invoice_payment_id: 'ip-1', already_booked: false },
    })
    expect(mocks.bookCollectedPayment).toHaveBeenCalledWith(expect.objectContaining({ db: serviceClient, companyId: 'company-1' }), PAYMENT_ID, { userId: 'user-1' })

    mocks.bookCollectedPayment.mockResolvedValueOnce({ ok: false, outcome: 'needs_review', reason: 'INVOICE_PAID_NO_FISCAL_PERIOD' })
    expect(await collectionsPaymentsBook.run(ctx(), { collected_payment_id: PAYMENT_ID }, { dryRun: false })).toEqual({
      ok: true,
      data: { outcome: 'needs_review', reason: 'INVOICE_PAID_NO_FISCAL_PERIOD' },
    })
  })
})

describe('collections.settlements.book', () => {
  it('previews the voucher the booking would post with the chosen accounts, and pins it with the day, amount and lines at staging', async () => {
    const outcome = await collectionsSettlementsBook.run(ctx(), { settlement_id: SETTLEMENT_ID, lines: [{ position: 1, account_number: '2641' }] }, { dryRun: true })
    expect(outcome.ok && outcome.dryRun).toBe(true)
    const preview = (outcome as { preview: Record<string, unknown> }).preview
    expect(preview).toMatchObject({
      payment_date: '2026-10-01',
      amount: 843.75,
      lines: [{ position: 0, account_number: '1689' }, { position: 1, account_number: '2641' }],
      voucher_lines: VOUCHER,
    })
    expect(mocks.previewSettlementVoucher).toHaveBeenCalledWith({ db: serviceClient }, 'company-1', SETTLEMENT_ID, [
      { position: 1, accountNumber: '2641', vatAccountNumber: undefined },
    ])
    expect(mocks.chooseSettlementLineAccounts).not.toHaveBeenCalled()
    expect(mocks.bookSettlement).not.toHaveBeenCalled()

    const pinned = collectionsSettlementsBook.mcp!.stage!.pinParams!({ settlement_id: SETTLEMENT_ID, lines: [{ position: 1, account_number: '2641' }] }, preview)
    expect(pinned).toEqual({
      settlement_id: SETTLEMENT_ID,
      lines: [{ position: 1, account_number: '2641' }],
      payment_date: '2026-10-01',
      expected_amount: 843.75,
      expected_lines: PINNED_LINES,
      expected_voucher: VOUCHER,
    })
    expect(collectionsSettlementsBook.input.safeParse(pinned).success).toBe(true)
  })

  it('never stages a booking the ledger cannot make with the choices given, and says why', async () => {
    mocks.previewSettlementVoucher.mockResolvedValueOnce({
      ok: false,
      reason: 'vat_unconfirmed',
      issues: [{ reason: 'vat_unconfirmed', position: 1 }],
      lineAccounts: [],
      details: {},
    })
    expect(await collectionsSettlementsBook.run(ctx(), { settlement_id: SETTLEMENT_ID }, { dryRun: true })).toEqual({
      ok: false,
      code: 'COLLECTION_SETTLEMENT_NEEDS_PERSON',
      details: { reason: 'vat_unconfirmed', issues: [{ reason: 'vat_unconfirmed', position: 1 }] },
    })
    expect(mocks.bookSettlement).not.toHaveBeenCalled()
  })

  it('records the choices and books as the person behind the call while the voucher is the one approved', async () => {
    const outcome = await collectionsSettlementsBook.run(
      ctx(),
      {
        settlement_id: SETTLEMENT_ID,
        lines: [{ position: 1, account_number: '2641' }],
        payment_date: '2026-10-01',
        expected_amount: 843.75,
        expected_lines: PINNED_LINES,
        expected_voucher: VOUCHER,
      },
      { dryRun: false },
    )
    expect(outcome).toEqual({ ok: true, data: { outcome: 'booked', journal_entry_id: 'je-d1', already_booked: false, acknowledged: true } })
    expect(mocks.chooseSettlementLineAccounts).toHaveBeenCalledWith(serviceClient, 'company-1', SETTLEMENT_ID, 'user-1', [
      { position: 1, accountNumber: '2641', vatAccountNumber: undefined },
    ])
    expect(mocks.bookSettlement).toHaveBeenCalledWith(expect.objectContaining({ db: serviceClient }), 'company-1', SETTLEMENT_ID, { userId: 'user-1' })
  })

  it('refuses at commit a voucher that is no longer the one approved (a setting or a choice changed), and writes nothing', async () => {
    // The approver saw the VAT on 2641; the voucher would now book it on 6062.
    mocks.previewSettlementVoucher.mockResolvedValueOnce(okPlan('6062'))
    const outcome = await collectionsSettlementsBook.run(
      ctx(),
      { settlement_id: SETTLEMENT_ID, payment_date: '2026-10-01', expected_amount: 843.75, expected_lines: PINNED_LINES, expected_voucher: VOUCHER },
      { dryRun: false },
    )
    expect(outcome).toEqual({ ok: false, code: 'COLLECTION_SETTLEMENT_CHANGED' })
    expect(mocks.chooseSettlementLineAccounts).not.toHaveBeenCalled()
    expect(mocks.bookSettlement).not.toHaveBeenCalled()
  })

  it('refuses a payout that changed after staging, and books nothing', async () => {
    const outcome = await collectionsSettlementsBook.run(
      ctx(),
      { settlement_id: SETTLEMENT_ID, expected_amount: 843.75, expected_lines: [{ position: 0, kind: 'principal', amount: 900, tax_amount: 0 }] },
      { dryRun: false },
    )
    expect(outcome).toEqual({ ok: false, code: 'COLLECTION_SETTLEMENT_CHANGED' })
    expect(await collectionsSettlementsBook.run(ctx(), { settlement_id: SETTLEMENT_ID, expected_amount: 800 }, { dryRun: false })).toEqual({
      ok: false,
      code: 'COLLECTION_SETTLEMENT_CHANGED',
    })
    expect(await collectionsSettlementsBook.run(ctx(), { settlement_id: SETTLEMENT_ID, payment_date: '2026-10-02' }, { dryRun: false })).toEqual({
      ok: false,
      code: 'COLLECTION_SETTLEMENT_CHANGED',
    })
    expect(mocks.chooseSettlementLineAccounts).not.toHaveBeenCalled()
    expect(mocks.bookSettlement).not.toHaveBeenCalled()
  })

  it('leaves a possible duplicate to a person and refuses an account a line cannot take', async () => {
    mocks.loadSettlementDetail.mockResolvedValueOnce(detail({ needsMappingReason: 'possible_duplicate', duplicateOf: { journalEntryId: 'je-hand', voucher: 'A88' } }))
    expect(await collectionsSettlementsBook.run(ctx(), { settlement_id: SETTLEMENT_ID }, { dryRun: true })).toEqual({
      ok: false,
      code: 'COLLECTION_SETTLEMENT_POSSIBLE_DUPLICATE',
      details: { duplicate_of: 'je-hand' },
    })
    expect(await collectionsSettlementsBook.run(ctx(), { settlement_id: SETTLEMENT_ID, lines: [{ position: 1, account_number: '3010' }] }, { dryRun: true })).toEqual({
      ok: false,
      code: 'COLLECTION_SETTLEMENT_LINE_INVALID',
      details: { position: 1 },
    })
    expect(mocks.bookSettlement).not.toHaveBeenCalled()
  })

  it('answers a payout that still waits for a person as needs_mapping, and a refusal with its code', async () => {
    // At commit a plan the ledger cannot book goes to the booking, which records the reason for a person.
    mocks.previewSettlementVoucher.mockResolvedValueOnce({ ok: false, reason: 'unknown_line', issues: [], lineAccounts: [], details: {} })
    mocks.bookSettlement.mockResolvedValueOnce({ ok: false, outcome: 'needs_mapping', reason: 'unknown_line', issues: [{ reason: 'unknown_line', position: 3 }] })
    expect(await collectionsSettlementsBook.run(ctx(), { settlement_id: SETTLEMENT_ID }, { dryRun: false })).toEqual({
      ok: true,
      data: { outcome: 'needs_mapping', reason: 'unknown_line', issues: [{ reason: 'unknown_line', position: 3 }] },
    })
    mocks.bookSettlement.mockResolvedValueOnce({ ok: false, outcome: 'busy' })
    expect(await collectionsSettlementsBook.run(ctx(), { settlement_id: SETTLEMENT_ID }, { dryRun: false })).toEqual({ ok: false, code: 'COLLECTION_SETTLEMENT_BUSY' })
    mocks.loadSettlementDetail.mockResolvedValueOnce(null)
    expect(await collectionsSettlementsBook.run(ctx(), { settlement_id: SETTLEMENT_ID }, { dryRun: false })).toEqual({ ok: false, code: 'COLLECTION_SETTLEMENT_NOT_FOUND' })
  })
})

describe('settlementMatchesPin', () => {
  const current = { amount: 843.75, lines: [{ position: 1, kind: 'agency_fee_vat' as const, amount: 31.25, tax_amount: 0 }, { position: 0, kind: 'principal' as const, amount: 1000, tax_amount: 0 }] }
  it('holds without a pin and for the same lines in any order', () => {
    expect(settlementMatchesPin(current, {})).toBe(true)
    expect(
      settlementMatchesPin(current, {
        expected_amount: 843.75,
        expected_lines: [
          { position: 0, kind: 'principal', amount: 1000, tax_amount: 0 },
          { position: 1, kind: 'agency_fee_vat', amount: 31.25, tax_amount: 0 },
        ],
      }),
    ).toBe(true)
  })
  it('fails on another amount, a changed or missing line, or another kind', () => {
    expect(settlementMatchesPin(current, { expected_amount: 843.74 })).toBe(false)
    expect(settlementMatchesPin(current, { expected_lines: [{ position: 0, kind: 'principal', amount: 1000, tax_amount: 0 }] })).toBe(false)
    expect(
      settlementMatchesPin(current, {
        expected_lines: [
          { position: 0, kind: 'principal', amount: 1000, tax_amount: 0 },
          { position: 1, kind: 'agency_commission', amount: 31.25, tax_amount: 0 },
        ],
      }),
    ).toBe(false)
  })
})
