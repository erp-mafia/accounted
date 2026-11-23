/**
 * A reverse charge booked on a bank row lands its base in one momsdeklaration
 * box. The cost account the booking ends on (the category's, or an
 * account_override) may report a box itself: then the 45xx/4598 basis pair
 * beside it would declare the purchase a second time, or the account's box
 * would be another than the one stated. The utlägg path refuses those
 * accounts; so must every categorize door.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events'

const mockCreateJE = vi.fn()
vi.mock('@/lib/suggestion-log/record', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/suggestion-log/record')>()),
  snapshotSuggestions: vi.fn(async (_supabase: unknown, companyId: string) => ({ companyId, byTransaction: new Map() })),
  recordDecisions: vi.fn(async () => undefined),
}))
vi.mock('@/lib/bookkeeping/transaction-entries', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/bookkeeping/transaction-entries')>()),
  createTransactionJournalEntry: (...args: unknown[]) => mockCreateJE(...args),
}))
vi.mock('@/lib/bookkeeping/cancel-orphaned-entry', () => ({ reverseOrphanedJournalEntry: vi.fn() }))
vi.mock('@/lib/transactions/booking-duplicate-detection', () => ({
  detectBookingDuplicate: vi.fn().mockResolvedValue(null),
}))
vi.mock('@/lib/transactions/inbox-underlag', () => ({
  propagateUnderlagForBookedTransaction: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/bookkeeping/counterparty-templates', () => ({
  upsertCounterpartyTemplate: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/transactions/link-journal-entry', () => ({
  hasLiveJournalEntryLink: vi.fn().mockResolvedValue(false),
}))
vi.mock('@/lib/processing-history/append', () => ({
  appendProcessingHistory: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/bookkeeping/account-validation', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/bookkeeping/account-validation')>()),
  findUnresolvableAccounts: vi.fn().mockResolvedValue([]),
}))
vi.mock('@/lib/bookkeeping/mapping-engine', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/bookkeeping/mapping-engine')>()),
  saveUserMappingRule: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/api/v1/check-period-lock', () => ({
  checkPeriodLock: vi.fn().mockResolvedValue({ locked: false }),
}))

import { categorizeMatchedTransaction, categorizeTransaction, type CategorizeInput } from '../categorize-core'
import type { ChartVatCode, ReverseChargeKind } from '@/lib/bookkeeping/vat-entries'

const TX_ID = '00000000-0000-4000-8000-0000000000cd'

const txRow = {
  id: TX_ID,
  company_id: 'company-1',
  date: '2026-07-10',
  amount: -1000,
  currency: 'SEK',
  amount_sek: -1000,
  exchange_rate: 1,
  description: 'FOREIGN SAAS',
  merchant_name: null,
  cash_account_id: null,
  document_id: null,
  journal_entry_id: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  mockCreateJE.mockResolvedValue({ id: 'je-rc-1' })
})

/** The reads before the mapping: the row, the booked gate, the settings, the settlement account, the override's chart row. */
function queued(accountOverride: string | undefined) {
  const mock = createQueuedMockSupabase()
  mock.enqueue({ data: txRow })
  mock.enqueue({ data: [] }) // the gate: no posted verifikat booked from the row
  mock.enqueue({ data: { entity_type: 'aktiebolag', fiscal_year_start_month: 1 } })
  mock.enqueue({ data: [] }) // resolveSettlementAccount: no enabled cash accounts -> 1930
  if (accountOverride) {
    mock.enqueue({ data: { account_number: accountOverride, account_class: Number(accountOverride[0]), is_active: true } })
  }
  return mock
}

/**
 * Book the row as a reverse-charge software purchase at the approval door
 * (the MCP commit, the bulk drivers), optionally on another account: the
 * posted cost account and VAT lines, or null when refused.
 */
async function approve(
  accountOverride: string | undefined,
  kind: ReverseChargeKind | undefined,
  momskoder: Record<string, ChartVatCode> = {},
) {
  const { supabase, enqueue } = queued(accountOverride)
  enqueue({ data: [{ id: 'fp-1' }] }) // ensureFiscalPeriod
  enqueue({ data: [{ id: TX_ID }] }) // transactions update
  mockCreateJE.mockClear()
  const result = await categorizeMatchedTransaction(supabase as never, 'user-1', 'company-1', TX_ID, {
    category: 'expense_software',
    vatTreatment: 'reverse_charge',
    reverseChargeKind: kind,
    accountOverride,
    loadChart: async () => new Map(Object.entries(momskoder)),
  })
  const posted = mockCreateJE.mock.calls[0]?.[4] as
    | { debit_account: string; vat_lines: Array<{ account_number: string }> }
    | undefined
  return {
    result,
    posted: posted ? [posted.debit_account, ...posted.vat_lines.map((l) => l.account_number)] : null,
  }
}

/** The same at an API or agent door, where the caller names the box (reverseChargeBoxParam): a dry run. */
async function viaApi(accountOverride: string, kind: ReverseChargeKind, momskoder: Record<string, ChartVatCode> = {}) {
  const { supabase } = queued(accountOverride)
  const input: CategorizeInput = {
    is_business: true,
    category: 'expense_software',
    vat_treatment: 'reverse_charge',
    reverse_charge_kind: kind,
    account_override: accountOverride,
  }
  return categorizeTransaction(supabase as never, 'user-1', 'company-1', TX_ID, input, {
    dryRun: true,
    onBooked: 'refuse',
    invoiceMatchIntercept: false,
    reverseChargeBoxParam: 'reverse_charge_kind',
    loadChart: async () => new Map(Object.entries(momskoder)),
  })
}

describe('categorize: reverse charge on a cost account that reports a box itself', () => {
  it('refuses an override onto the import basis (ruta 50) instead of booking a ruta 22 basis beside it', async () => {
    const { result, posted } = await approve('4545', 'non_eu_services')
    expect(posted).toBeNull()
    expect(result).toMatchObject({ status: 400, errorCode: 'TX_CATEGORIZE_REVERSE_CHARGE_ACCOUNT' })
    expect(result.error).toMatch(/Konto 4545 redovisar själv en annan momsruta än 20-24/)
  })

  it('refuses trepartshandel (4512, ruta 37) and the 4598 offset as the cost account', async () => {
    for (const account of ['4512', '4598']) {
      const { result, posted } = await approve(account, 'eu_services')
      expect(posted, account).toBeNull()
      expect(result, account).toMatchObject({ status: 400, errorCode: 'TX_CATEGORIZE_REVERSE_CHARGE_ACCOUNT' })
    }
  })

  it('refuses a cost account whose momskod is import or trepartshandel, or reverse charge without a Swedish rate', async () => {
    const codes: Record<string, ChartVatCode> = {
      '6550': { default_vat_treatment: 'import_goods', default_vat_rate: 0.25 },
      '6551': { default_vat_treatment: 'triangulation_eu_goods', default_vat_rate: 0 },
      '6552': { default_vat_treatment: 'reverse_charge_eu_services', default_vat_rate: 0 },
    }
    for (const account of Object.keys(codes)) {
      const { result, posted } = await approve(account, 'eu_services', codes)
      expect(posted, account).toBeNull()
      expect(result, account).toMatchObject({ status: 400, errorCode: 'TX_CATEGORIZE_REVERSE_CHARGE_ACCOUNT' })
    }
  })

  it("refuses the category's own account too when its momskod declares another box (no override)", async () => {
    const { result, posted } = await approve(undefined, 'eu_services', {
      '5420': { default_vat_treatment: 'import_goods', default_vat_rate: 0.25 },
    })
    expect(posted).toBeNull()
    expect(result).toMatchObject({ status: 400, errorCode: 'TX_CATEGORIZE_REVERSE_CHARGE_ACCOUNT' })
  })

  it('refuses, at a door where the caller names the box, an account that reports its own ruta for another purchase', async () => {
    // 4531 is ruta 22: a named EU service (ruta 21) cannot land there.
    const named = await viaApi('4531', 'eu_services')
    expect(named).toMatchObject({
      ok: false,
      code: 'TX_CATEGORIZE_REVERSE_CHARGE_ACCOUNT',
      details: { reason: 'other_kind', account_number: '4531', account_box: 'ruta22', requested_box: 'ruta21', parameter: 'reverse_charge_kind' },
    })
    // A momskod makes the account report its box as 4531 does by number.
    const configured = await viaApi('6541', 'non_eu_services', {
      '6541': { default_vat_treatment: 'reverse_charge_eu_services', default_vat_rate: 0.25 },
    })
    expect(configured).toMatchObject({ ok: false, details: { reason: 'other_kind', account_box: 'ruta21' } })
    // The box it reports itself is accepted.
    expect(await viaApi('4531', 'non_eu_services')).toMatchObject({ ok: true })
  })

  it('still books an ordinary cost account with the pair, and an own-box account without it', async () => {
    expect((await approve('6540', 'eu_services')).posted).toEqual(['6540', '2645', '2614', '4535', '4598'])
    expect((await approve('4531', 'non_eu_services')).posted).toEqual(['4531', '2645', '2614'])
    // No box named: the account's own box decides.
    expect((await approve('4531', undefined)).posted).toEqual(['4531', '2645', '2614'])
    // A class 7 account reports no box: the pair books it, as for an utlägg.
    expect((await approve('7610', 'eu_services')).posted).toEqual(['7610', '2645', '2614', '4535', '4598'])
  })
})
