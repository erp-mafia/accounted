/**
 * A reverse charge booked on a bank row lands its base in one momsdeklaration
 * box. The cost account the booking ends on (the category's, or an
 * account_override) may report a box itself: then the 45xx/4598 basis pair
 * beside it would declare the purchase a second time, or the account's box
 * would be another than the one stated. The utlägg path refuses those
 * accounts; so must every categorize door.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase, makeCategorizationTemplate } from '@/tests/helpers'
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
vi.mock('@/lib/bookkeeping/counterparty-templates', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/bookkeeping/counterparty-templates')>()),
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

/**
 * The reads before the mapping: the row, the booked gate, the settings, the settlement account, the inbox items
 * matched to the row (the seller-VAT check of a reverse charge), the override's chart row.
 */
function queued(accountOverride: string | undefined) {
  const mock = createQueuedMockSupabase()
  mock.enqueue({ data: txRow })
  mock.enqueue({ data: [] }) // the gate: no posted verifikat booked from the row
  mock.enqueue({ data: { entity_type: 'aktiebolag', fiscal_year_start_month: 1 } })
  mock.enqueue({ data: [] }) // resolveSettlementAccount: no enabled cash accounts -> 1930
  mock.enqueue({ data: [] }) // the seller-VAT check: no inbox item matched to the row
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
  reverseChargeBoxParam?: 'vat_treatment',
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
    ...(reverseChargeBoxParam ? { reverseChargeBoxParam } : {}),
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
    // The reverse charge is what is wrong on an import base, not the account.
    expect(result.error).toMatch(/Konto 4545 är beskattningsunderlaget vid import \(ruta 50\)/)
    expect(result.error).toMatch(/Bokför importen utan omvänd betalningsskyldighet, med importmomsen/)
  })

  it('refuses trepartshandel (4512, ruta 37) and the 4598 offset as the cost account', async () => {
    const triangulation = await approve('4512', 'eu_services')
    expect(triangulation.posted).toBeNull()
    expect(triangulation.result).toMatchObject({ status: 400, errorCode: 'TX_CATEGORIZE_REVERSE_CHARGE_ACCOUNT' })
    expect(triangulation.result.error).toMatch(/ruta 37.*ingen omvänd betalningsskyldighet: bokför det utan den/)
    const offset = await approve('4598', 'eu_services')
    expect(offset.posted).toBeNull()
    expect(offset.result.error).toMatch(/Konto 4598 är motkontot till underlaget/)
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
    // Only the momskod without a sats is answered with the kontoplan.
    expect((await approve('6552', 'eu_services', codes)).result.error).toMatch(/Rätta kontots momssats i kontoplanen/)
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

  it('holds a box named at staging against the account at approval, and not one read off the underlag', async () => {
    // Staged on 6541 as a service from outside the EU (ruta 22, booked by the
    // pair); the company then set 6541 to report ruta 21 itself.
    const changed: Record<string, ChartVatCode> = {
      '6541': { default_vat_treatment: 'reverse_charge_eu_services', default_vat_rate: 0.25 },
    }
    const named = await approve('6541', 'non_eu_services', changed, 'vat_treatment')
    expect(named.posted).toBeNull()
    expect(named.result).toMatchObject({ status: 400, errorCode: 'TX_CATEGORIZE_REVERSE_CHARGE_ACCOUNT' })
    expect(named.result.error).toMatch(/Konto 6541 redovisar själv ruta 21, men vat_treatment anger ruta 22/)
    // The box the underlag gave is no statement: the account's own box decides, as at staging.
    expect((await approve('6541', 'non_eu_services', changed)).posted).toEqual(['6541', '2645', '2614'])
  })

  it('tells a caller only no box on an account that reports ruta 23 or 24, which no door can name', async () => {
    type Refusal = { message?: { sv: string; en?: string } }
    for (const [account, box] of [['4415', 'ruta23'], ['4425', 'ruta24']] as const) {
      const refused = await viaApi(account, 'eu_services')
      expect(refused, account).toMatchObject({
        ok: false,
        code: 'TX_CATEGORIZE_REVERSE_CHARGE_ACCOUNT',
        details: { reason: 'other_kind', account_number: account, account_box: box, requested_box: 'ruta21' },
      })
      const message = (refused as Refusal).message
      expect(message?.sv, account).toMatch(/Stämmer kontot, ange ingen ruta, så gäller kontots egen/)
      expect(message?.sv, account).not.toMatch(/ange ruta 2[34]/)
      expect(message?.en, account).toMatch(/If the account is right, name no box, and the account's own applies/)
    }
    // A box a caller can name (4531, ruta 22) is still offered.
    const named = (await viaApi('4531', 'eu_services')) as Refusal
    expect(named.message?.sv).toMatch(/Stämmer kontot, ange ruta 22 eller ingen ruta/)
  })

  it('refuses a catalog template whose cost account the company set to the import basis', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: txRow })
    enqueue({ data: [] }) // the gate: no posted verifikat booked from the row
    enqueue({ data: { entity_type: 'aktiebolag', fiscal_year_start_month: 1 } })
    enqueue({ data: [] }) // resolveSettlementAccount: no enabled cash accounts -> 1930
    // it_saas_eu books reverse charge on 5420, which this company reports in ruta 50.
    const outcome = await categorizeTransaction(supabase as never, 'user-1', 'company-1', TX_ID, {
      is_business: true,
      template_id: 'it_saas_eu',
    }, {
      dryRun: true,
      onBooked: 'refuse',
      invoiceMatchIntercept: false,
      loadChart: async () => new Map([['5420', { default_vat_treatment: 'import_goods', default_vat_rate: 0.25 }]]),
    })
    expect(outcome).toMatchObject({
      ok: false,
      code: 'TX_CATEGORIZE_REVERSE_CHARGE_ACCOUNT',
      details: { reason: 'other_box', account_number: '5420', account_box: 'ruta50' },
    })
  })

  /** A learned pair on `account` with reverse charge, booked on a row of `amount`. */
  async function learned(amount: number, account = '4545') {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { ...txRow, amount, amount_sek: amount } })
    enqueue({ data: [] }) // the gate: no posted verifikat booked from the row
    enqueue({ data: { entity_type: 'aktiebolag', fiscal_year_start_month: 1 } })
    enqueue({
      data: makeCategorizationTemplate({
        id: 'tmpl-rc',
        counterparty_name: 'Freight forwarder',
        debit_account: account,
        credit_account: '1930',
        vat_treatment: 'reverse_charge',
        vat_account: '2645',
        category: 'expense_other',
      }),
    })
    enqueue({ data: [] }) // resolveSettlementAccount: no enabled cash accounts -> 1930
    return categorizeTransaction(supabase as never, 'user-1', 'company-1', TX_ID, {
      is_business: true,
      counterparty_template_id: 'tmpl-rc',
    }, {
      dryRun: true,
      onBooked: 'refuse',
      invoiceMatchIntercept: false,
      loadChart: async () => new Map(),
    })
  }

  it('refuses a learned template on the import basis, on a purchase and on its refund (the credit side)', async () => {
    const refused = { ok: false, code: 'TX_CATEGORIZE_REVERSE_CHARGE_ACCOUNT', details: { reason: 'other_box', account_number: '4545' } }
    expect(await learned(-1000)).toMatchObject(refused)
    // Money back against the learned direction mirrors the set: the basis and
    // the cost line sit on the credit side, and the rule reads them there.
    expect(await learned(1000)).toMatchObject(refused)
    // On an ordinary cost account the refund books the mirrored set: the rule
    // read the credit side, not an empty one.
    const refund = await learned(1000, '6540')
    expect(refund).toMatchObject({ ok: true, preview: { mappingResult: { credit_account: '6540' } } })
    const lines = refund.ok && refund.dryRun ? refund.preview.mappingResult.vat_lines : []
    expect(lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])).toEqual([
      ['2645', 0, 250], ['2614', 250, 0], ['4535', 0, 1000], ['4598', 1000, 0],
    ])
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

/**
 * A template books its own reverse-charge box: the basis pair it was built
 * with, or the box its cost account reports itself. A caller that names
 * another box beside it (reverse_charge_kind at the v1 doors) would get the
 * template's box declared while the preview echoes the named one.
 */
describe('categorize: a box named beside a template', () => {
  type Booked = { debit: string; vat: string[]; echo: ReverseChargeKind | undefined }

  /** A dry run at the v1 door: the template, reverse charge, and the box named. */
  async function viaTemplate(
    by: { template_id: string } | { counterparty_template_id: string },
    kind: ReverseChargeKind | undefined,
    {
      dryRun = true,
      momskoder = {},
      learned = {},
      amount = -1000,
    }: {
      dryRun?: boolean
      momskoder?: Record<string, ChartVatCode>
      /** Fields of the learned template over the single pair on 6540. */
      learned?: Partial<Parameters<typeof makeCategorizationTemplate>[0]>
      /** The row's amount: money in books a learned purchase as its refund. */
      amount?: number
    } = {},
  ) {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { ...txRow, amount, amount_sek: amount } })
    enqueue({ data: [] }) // the gate: no posted verifikat booked from the row
    enqueue({ data: { entity_type: 'aktiebolag', fiscal_year_start_month: 1 } })
    enqueue({ data: [] }) // the seller-VAT check: no inbox item matched to the row
    if ('counterparty_template_id' in by) {
      // A learned single pair with reverse charge on an ordinary cost account.
      enqueue({
        data: makeCategorizationTemplate({
          id: by.counterparty_template_id,
          counterparty_name: 'Foreign consultant',
          debit_account: '6540',
          credit_account: '1930',
          vat_treatment: 'reverse_charge',
          vat_account: '2645',
          category: 'expense_other',
          ...learned,
        }),
      })
    }
    enqueue({ data: [] }) // resolveSettlementAccount: no enabled cash accounts -> 1930
    mockCreateJE.mockClear()
    return categorizeTransaction(supabase as never, 'user-1', 'company-1', TX_ID, {
      is_business: true,
      ...by,
      vat_treatment: 'reverse_charge',
      ...(kind ? { reverse_charge_kind: kind } : {}),
    }, {
      dryRun,
      onBooked: 'refuse',
      invoiceMatchIntercept: false,
      reverseChargeBoxParam: 'reverse_charge_kind',
      loadChart: async () => new Map(Object.entries(momskoder)),
    })
  }

  function booked(outcome: Awaited<ReturnType<typeof viaTemplate>>): Booked | null {
    if (!outcome.ok || !outcome.dryRun) return null
    const { mappingResult, reverse_charge_kind } = outcome.preview
    return { debit: mappingResult.debit_account, vat: mappingResult.vat_lines.map((l) => l.account_number), echo: reverse_charge_kind }
  }

  const learnedId = { counterparty_template_id: '00000000-0000-4000-8000-0000000000aa' }

  /** A learned line pattern: a cost line on each account, then its own basis pair. */
  function pattern(costAccounts: string[], basis: string) {
    return {
      vat_treatment: null,
      vat_account: null,
      line_pattern: [
        ...costAccounts.map((account) => ({ account, type: 'business' as const, side: 'debit' as const, ratio: 1 / costAccounts.length })),
        { account: basis, type: 'business' as const, side: 'debit' as const, ratio: 1 },
        { account: '4598', type: 'business' as const, side: 'credit' as const, ratio: 1 },
      ],
    }
  }

  it('refuses a box the catalog template does not book, whether its account or its basis pair declares the box', async () => {
    // goods_purchase_eu books on 4515, which reports ruta 20 itself.
    expect(await viaTemplate({ template_id: 'goods_purchase_eu' }, 'non_eu_services')).toMatchObject({
      ok: false,
      code: 'VALIDATION_ERROR',
      details: { field: 'reverse_charge_kind', template_id: 'goods_purchase_eu', template_boxes: ['ruta20'], requested_box: 'ruta22' },
    })
    // it_saas_non_eu books its basis pair in ruta 22, it_saas_eu in ruta 21.
    expect(await viaTemplate({ template_id: 'it_saas_non_eu' }, 'eu_services')).toMatchObject({
      ok: false,
      details: { template_boxes: ['ruta22'], requested_box: 'ruta21' },
    })
    expect(await viaTemplate({ template_id: 'it_saas_eu' }, 'non_eu_services')).toMatchObject({
      ok: false,
      details: { template_boxes: ['ruta21'], requested_box: 'ruta22' },
    })
  })

  it('says which box the template books and what to send instead', async () => {
    const refused = await viaTemplate({ template_id: 'goods_purchase_eu' }, 'non_eu_services')
    const message = (refused as { message?: { sv: string; en?: string } }).message
    expect(message?.sv).toBe(
      'Mallen bokför köpet i ruta 20, men reverse_charge_kind anger ruta 22. Stämmer mallen, ange ruta 20 eller ingen ruta. ' +
        'Annars bokför transaktionen med en kategori och den angivna rutan.',
    )
    expect(message?.en).toBe(
      'The template books the purchase in box 20, but reverse_charge_kind names box 22. If the template is right, name box 20 or no box. ' +
        'Otherwise book the transaction by category with the box named.',
    )
  })

  it('refuses a box a learned template does not book, and the booking posts nothing', async () => {
    const tmpl = learnedId
    expect(await viaTemplate(tmpl, 'non_eu_services')).toMatchObject({
      ok: false,
      code: 'VALIDATION_ERROR',
      details: { field: 'reverse_charge_kind', ...tmpl, template_boxes: ['ruta21'], requested_box: 'ruta22' },
    })
    expect(await viaTemplate(tmpl, 'non_eu_services', { dryRun: false })).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' })
    expect(mockCreateJE).not.toHaveBeenCalled()
    // A learned line pattern replays its own basis pair: ruta 22 on 4531.
    const onRuta22 = pattern(['6540'], '4531')
    expect(await viaTemplate(tmpl, 'eu_services', { learned: onRuta22 })).toMatchObject({
      ok: false,
      details: { template_boxes: ['ruta22'], requested_box: 'ruta21' },
    })
    expect(booked(await viaTemplate(tmpl, 'non_eu_services', { learned: onRuta22 }))).toMatchObject({ echo: 'non_eu_services' })
  })

  it('reads the box of a learned purchase booked as its refund, on the credit side', async () => {
    expect(await viaTemplate(learnedId, 'non_eu_services', { amount: 1000 })).toMatchObject({
      ok: false,
      details: { template_boxes: ['ruta21'], requested_box: 'ruta22' },
    })
    expect(booked(await viaTemplate(learnedId, 'eu_services', { amount: 1000 }))).toMatchObject({ echo: 'eu_services' })
  })

  it('reads the box of a basis pair that no cost line stands beside, which the booking keeps whole', async () => {
    // The pattern's cost line is a tax line: the pair keeps the whole purchase in ruta 21.
    const learned = {
      vat_treatment: null,
      vat_account: null,
      line_pattern: [
        { account: '6540', type: 'tax' as const, side: 'debit' as const, ratio: 1 },
        { account: '4535', type: 'business' as const, side: 'debit' as const, ratio: 1 },
        { account: '4598', type: 'business' as const, side: 'credit' as const, ratio: 1 },
      ],
    }
    expect(booked(await viaTemplate(learnedId, 'eu_services', { learned }))).toMatchObject({
      vat: expect.arrayContaining(['4535', '4598']), echo: 'eu_services',
    })
    expect(await viaTemplate(learnedId, 'non_eu_services', { learned })).toMatchObject({
      ok: false,
      details: { template_boxes: ['ruta21'], requested_box: 'ruta22' },
    })
  })

  it('offers no box for a template in ruta 24, which no door can name', async () => {
    const refused = await viaTemplate(learnedId, 'eu_services', { learned: pattern(['6540'], '4425') })
    expect(refused).toMatchObject({ ok: false, details: { template_boxes: ['ruta24'], requested_box: 'ruta21' } })
    expect((refused as { message?: { sv: string } }).message?.sv).toMatch(/Stämmer mallen, ange ingen ruta\./)
  })

  it('refuses a box for part of a purchase the template splits over two boxes', async () => {
    // 5420 reports ruta 22 itself; 6540 takes the pattern's ruta 21 pair.
    const momskoder = { '5420': { default_vat_treatment: 'reverse_charge_non_eu_services', default_vat_rate: 0.25 } }
    const refused = await viaTemplate(learnedId, 'eu_services', { learned: pattern(['6540', '5420'], '4535'), momskoder })
    expect(refused).toMatchObject({ ok: false, details: { template_boxes: ['ruta21', 'ruta22'], requested_box: 'ruta21' } })
    expect((refused as { message?: { sv: string } }).message?.sv).toMatch(/^Mallen bokför köpet i rutorna 21 och 22, .* ange ingen ruta\./)
  })

  it('reads a momskod on the basis account itself, as the momsdeklaration does', async () => {
    // The company reports 4535 in ruta 22: it_saas_eu's pair then lands there.
    const momskoder = { '4535': { default_vat_treatment: 'reverse_charge_non_eu_services', default_vat_rate: 0.25 } }
    expect(await viaTemplate({ template_id: 'it_saas_eu' }, 'eu_services', { momskoder })).toMatchObject({
      ok: false,
      details: { template_boxes: ['ruta22'], requested_box: 'ruta21' },
    })
  })

  it('refuses a box beside a template that books no reverse-charge purchase', async () => {
    // A reverse-charge sale declares no purchase box.
    const refused = await viaTemplate({ template_id: 'revenue_eu_services' }, 'eu_services', { amount: 1000 })
    expect(refused).toMatchObject({
      ok: false,
      code: 'VALIDATION_ERROR',
      details: { field: 'reverse_charge_kind', template_id: 'revenue_eu_services', template_boxes: [], requested_box: 'ruta21' },
    })
    expect((refused as { message?: { sv: string } }).message?.sv).toMatch(/^Mallen bokför inget köp med omvänd betalningsskyldighet/)
    expect(await viaTemplate({ template_id: 'revenue_eu_services' }, undefined, { amount: 1000 })).toMatchObject({ ok: true })
  })

  it('books the template\'s own box when none is named, without reading one off the underlag', async () => {
    expect(booked(await viaTemplate({ template_id: 'it_saas_non_eu' }, undefined))).toEqual({
      debit: '5420', vat: ['2645', '2614', '4531', '4598'], echo: undefined,
    })
  })

  it('reads the box an account reports through its momskod, as the booking settles it', async () => {
    // The company reports 5420 in ruta 22 itself: it_saas_eu then books ruta 22, not its pair's ruta 21.
    const momskoder = { '5420': { default_vat_treatment: 'reverse_charge_non_eu_services', default_vat_rate: 0.25 } }
    expect(await viaTemplate({ template_id: 'it_saas_eu' }, 'eu_services', { momskoder })).toMatchObject({
      ok: false,
      details: { template_boxes: ['ruta22'], requested_box: 'ruta21' },
    })
    expect(booked(await viaTemplate({ template_id: 'it_saas_eu' }, 'non_eu_services', { momskoder }))).toEqual({
      debit: '5420', vat: ['2645', '2614'], echo: 'non_eu_services',
    })
  })

  it('books the box it names when the template books it, and the preview echoes the box booked', async () => {
    expect(booked(await viaTemplate({ template_id: 'goods_purchase_eu' }, 'eu_goods'))).toEqual({
      debit: '4515', vat: ['2645', '2614'], echo: 'eu_goods',
    })
    expect(booked(await viaTemplate({ template_id: 'it_saas_non_eu' }, 'non_eu_services'))).toEqual({
      debit: '5420', vat: ['2645', '2614', '4531', '4598'], echo: 'non_eu_services',
    })
    expect(booked(await viaTemplate(learnedId, 'eu_services'))).toEqual({
      debit: '6540', vat: ['2645', '2614', '4535', '4598'], echo: 'eu_services',
    })
  })
})
