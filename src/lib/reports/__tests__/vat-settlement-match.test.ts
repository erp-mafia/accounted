/**
 * Which momsperiod a momsredovisning settles, read by amount (crm#1316), as
 * the proposal, the momsdeklaration card's status and the booking guard see
 * it. Run against one in-memory ledger (lib/measures/__tests__/fake-ledger):
 * the VAT totals RPC, its settlement shapes (stated per fixture, the SQL's
 * decision) and every table read are answered from the same entries.
 */
import { describe, expect, it, vi } from 'vitest'
import { createFakeLedger, type FakeEntry, type FakeLedgerData } from '@/lib/measures/__tests__/fake-ledger'
import { buildVatSettlementProposal, vatSettlementBookingStatus } from '../vat-settlement'
import { bookVatSettlement } from '../vat-settlement-booking'

vi.mock('@/lib/api/v1/check-period-lock', () => ({ checkPeriodLock: vi.fn(async () => ({ locked: false })) }))

const CO = '00000000-0000-4000-8000-00000000c0de'
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as never

const CHART: FakeLedgerData['chart'] = [
  { account_number: '1630', account_name: 'Skattekonto', account_class: 1 },
  { account_number: '1650', account_name: 'Momsfordran', account_class: 1 },
  { account_number: '1930', account_name: 'Företagskonto', account_class: 1 },
  { account_number: '2610', account_name: 'Utgående moms 25 %', account_class: 2 },
  { account_number: '2611', account_name: 'Utgående moms på försäljning inom Sverige, 25 %', account_class: 2 },
  { account_number: '2614', account_name: 'Utgående moms omvänd skattskyldighet, 25 %', account_class: 2 },
  { account_number: '2641', account_name: 'Debiterad ingående moms', account_class: 2 },
  { account_number: '2645', account_name: 'Beräknad ingående moms på förvärv från utlandet', account_class: 2 },
  { account_number: '2650', account_name: 'Redovisningskonto för moms', account_class: 2 },
  { account_number: '3740', account_name: 'Öres- och kronutjämning', account_class: 3 },
]

let seq = 0
function entry(date: string, lines: FakeEntry['lines'], overrides: Partial<FakeEntry> = {}): FakeEntry {
  seq += 1
  return {
    id: `e0000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    entry_date: date,
    voucher_number: seq,
    description: 'Verifikat',
    source_type: 'manual',
    fiscal_period_id: 'fp',
    lines,
    ...overrides,
  }
}

function ledger(options: {
  fiscalPeriods: FakeLedgerData['fiscalPeriods']
  entries: FakeEntry[]
  shaped: FakeEntry[]
  lockedThrough?: string
}) {
  return createFakeLedger({
    companyId: CO,
    fiscalPeriods: options.fiscalPeriods,
    chart: CHART,
    entries: options.entries,
    vatShapedEntryIds: options.shaped.map((e) => e.id),
    extraTables: {
      company_settings: [{ company_id: CO, accounting_method: 'accrual', bookkeeping_locked_through: options.lockedThrough ?? null }],
    },
  }).supabase
}

const ctxOf = (supabase: ReturnType<typeof ledger>) => ({ supabase, companyId: CO, userId: 'u', log }) as never

const calendarYears = (closed: number[], open: number[]) =>
  [...closed.map((y) => ({ y, closed: true })), ...open.map((y) => ({ y, closed: false }))].map(({ y, closed }) => ({
    id: `f${y}0000-0000-4000-8000-000000000000`,
    period_start: `${y}-01-01`,
    period_end: `${y}-12-31`,
    is_closed: closed,
    locked_at: closed ? `${y + 1}-09-01T00:00:00Z` : null,
  }))

describe('crm#1316: helårsmoms settled straight against the skattekonto on the day Skatteverket debited it', () => {
  // 2024: 69 950 + 1 225 output VAT, settled 2025-08-18 straight against 1630.
  // 2025: 18 750 output VAT, settled on 2025-12-31 against 2650. Both years closed.
  const sale2024 = entry('2024-06-30', [{ account_number: '1930', debit: 357_125 }, { account_number: '2610', credit: 69_950 }, { account_number: '2611', credit: 1_225 }, { account_number: '3001', credit: 285_950 }])
  const settled2024 = entry('2025-08-18', [{ account_number: '2610', debit: 69_950 }, { account_number: '2611', debit: 1_225 }, { account_number: '1630', credit: 71_175 }], { voucher_number: 13, description: 'Moms 2024', source_type: 'import' })
  const sale2025 = entry('2025-05-31', [{ account_number: '1930', debit: 93_750 }, { account_number: '2610', credit: 18_750 }, { account_number: '3001', credit: 75_000 }])
  const settled2025 = entry('2025-12-31', [{ account_number: '2610', debit: 18_750 }, { account_number: '2650', credit: 18_750 }], { voucher_number: 20, description: 'Momsredovisning 2025', source_type: 'import' })
  const years = calendarYears([2024, 2025], [2026])

  it('names the late verifikat as the period\'s settlement, so the card shows it booked', async () => {
    const supabase = ledger({ fiscalPeriods: years, entries: [sale2024, settled2024, sale2025, settled2025], shaped: [settled2024, settled2025] })
    const proposal = await buildVatSettlementProposal(supabase, CO, 'yearly', 2024, 1)
    expect(proposal.entry_date).toBe('2026-01-01')
    expect(proposal.filed_net).toBe(71_175)
    expect(proposal.existing_entries).toEqual([
      expect.objectContaining({
        id: settled2024.id,
        status: 'posted',
        entry_date: '2025-08-18',
        voucher_number: 13,
        late_settlement: { cleared: 71_175, net: 71_175, via: 'tax_account' },
      }),
    ])
    expect(vatSettlementBookingStatus(proposal.existing_entries)).toBe('booked')
  })

  it('refuses to book the period a second time, naming the verifikat', async () => {
    const supabase = ledger({ fiscalPeriods: years, entries: [sale2024, settled2024, sale2025, settled2025], shaped: [settled2024, settled2025] })
    const outcome = await bookVatSettlement(ctxOf(supabase), { period_type: 'yearly', year: 2024, period: 1 }, { dryRun: true })
    expect(outcome).toMatchObject({
      ok: false,
      code: 'VAT_SETTLEMENT_ALREADY_BOOKED',
      details: { journal_entry_id: settled2024.id, voucher_series: 'A', voucher_number: 13, entry_date: '2025-08-18' },
    })
  })

  it('does not count the earlier year\'s settlement as the next year\'s own', async () => {
    const supabase = ledger({ fiscalPeriods: years, entries: [sale2024, settled2024, sale2025, settled2025], shaped: [settled2024, settled2025] })
    const proposal = await buildVatSettlementProposal(supabase, CO, 'yearly', 2025, 1)
    expect(proposal.existing_entries.map((e) => e.id)).toEqual([settled2025.id])
    expect(proposal.existing_entries[0]).not.toHaveProperty('late_settlement')
  })

  it('leaves the next year bookable while its own settlement is missing', async () => {
    const supabase = ledger({ fiscalPeriods: years, entries: [sale2024, settled2024, sale2025], shaped: [settled2024] })
    const proposal = await buildVatSettlementProposal(supabase, CO, 'yearly', 2025, 1)
    expect(proposal.existing_entries).toEqual([])
    expect(vatSettlementBookingStatus(proposal.existing_entries)).toBe('none')
    const outcome = await bookVatSettlement(ctxOf(supabase), { period_type: 'yearly', year: 2025, period: 1 }, { dryRun: true })
    expect(outcome).toMatchObject({ ok: true, dryRun: true })
  })
})

describe('helårsmoms refund settled after a closed broken räkenskapsår', () => {
  // Räkenskapsår 2025-10-19..2026-09-30 (closed, locked through its end) with
  // a refund of 6 140,10; the year-end opening balance carries the 26xx
  // balances into the next year, and the refund is settled to 1650 on
  // 2026-10-11, inside the next räkenskapsår.
  const years: FakeLedgerData['fiscalPeriods'] = [
    { id: 'f2026000-0000-4000-8000-000000000000', period_start: '2025-10-19', period_end: '2026-09-30', is_closed: true, locked_at: '2026-10-05T00:00:00Z' },
    { id: 'f2027000-0000-4000-8000-000000000000', period_start: '2026-10-01', period_end: '2027-09-30', is_closed: false, locked_at: null },
  ]
  const purchases = entry('2026-03-31', [
    { account_number: '1930', debit: 1_153.86 },
    { account_number: '2611', credit: 1_153.86 },
    { account_number: '2641', debit: 7_293.96 },
    { account_number: '2645', debit: 4_127.38 },
    { account_number: '2614', credit: 4_127.38 },
    { account_number: '1930', credit: 7_293.96 },
  ])
  const openingBalance = entry('2026-10-01', [
    { account_number: '2641', debit: 7_293.96 },
    { account_number: '2645', debit: 4_127.38 },
    { account_number: '2611', credit: 1_153.86 },
    { account_number: '2614', credit: 4_127.38 },
    { account_number: '1930', credit: 6_140.1 },
  ], { source_type: 'opening_balance' })
  const refund = entry('2026-10-11', [
    { account_number: '2611', debit: 1_153.86 },
    { account_number: '2614', debit: 4_127.38 },
    { account_number: '2641', credit: 7_293.96 },
    { account_number: '2645', credit: 4_127.38 },
    { account_number: '1650', debit: 6_140 },
    { account_number: '3740', debit: 0.1 },
  ], { voucher_number: 6, description: 'Momsredovisning' })

  it('names the refund as the closed year\'s settlement and refuses a second one', async () => {
    const supabase = ledger({ fiscalPeriods: years, entries: [purchases, openingBalance, refund], shaped: [refund], lockedThrough: '2026-09-30' })
    const proposal = await buildVatSettlementProposal(supabase, CO, 'yearly', 2026, 1)
    expect(proposal.period).toMatchObject({ start: '2025-10-19', end: '2026-09-30' })
    expect(proposal.entry_date).toBe('2026-10-01')
    expect(proposal.filed_net).toBeLessThan(0)
    expect(proposal.existing_entries).toEqual([
      expect.objectContaining({ id: refund.id, entry_date: '2026-10-11', late_settlement: expect.objectContaining({ cleared: -6_140.1, via: 'net_account' }) }),
    ])
    const outcome = await bookVatSettlement(ctxOf(supabase), { period_type: 'yearly', year: 2026, period: 1 }, { dryRun: true })
    expect(outcome).toMatchObject({ ok: false, code: 'VAT_SETTLEMENT_ALREADY_BOOKED', details: { journal_entry_id: refund.id } })
  })

  it('leaves the next year ungated: its declaration no longer reads what the opening balance carried in (crm#1333)', async () => {
    // The opening balance carries the closed year's VAT, which that year's
    // declaration already holds; the refund settles the closed year, so it
    // belongs to one period only, and the next year has nothing to settle.
    const supabase = ledger({ fiscalPeriods: years, entries: [purchases, openingBalance, refund], shaped: [refund], lockedThrough: '2026-09-30' })
    const proposal = await buildVatSettlementProposal(supabase, CO, 'yearly', 2027, 1)
    expect(proposal.filed_net).toBe(0)
    expect(proposal.existing_entries).toEqual([])
  })
})

describe('quarterly momsredovisning', () => {
  const years = calendarYears([], [2026])
  // Q1 and Q2 each hold 2611 1 250 and 2641 100: ruta 49 1 150.
  const sale = (date: string) => entry(date, [{ account_number: '1930', debit: 1_150 }, { account_number: '2641', debit: 100 }, { account_number: '2611', credit: 1_250 }])
  const settlement = (date: string, overrides: Partial<FakeEntry> = {}) =>
    entry(date, [{ account_number: '2611', debit: 1_250 }, { account_number: '2641', credit: 100 }, { account_number: '2650', credit: 1_150 }], overrides)

  it('is unchanged for a settlement booked on the period\'s last day', async () => {
    const q1Sale = sale('2026-02-15')
    const q1Settled = settlement('2026-03-31', { source_type: 'vat_settlement', description: 'Momsredovisning Kvartal 1 2026' })
    const q2Sale = sale('2026-05-15')
    const supabase = ledger({ fiscalPeriods: years, entries: [q1Sale, q1Settled, q2Sale], shaped: [] })

    const q1 = await buildVatSettlementProposal(supabase, CO, 'quarterly', 2026, 1)
    expect(q1.existing_entries).toEqual([
      expect.objectContaining({ id: q1Settled.id, status: 'posted', entry_date: '2026-03-31', source_type: 'vat_settlement' }),
    ])
    expect(q1.existing_entries[0]).not.toHaveProperty('late_settlement')
    const q2 = await buildVatSettlementProposal(supabase, CO, 'quarterly', 2026, 2)
    expect(q2.existing_entries).toEqual([])
    expect(q2.filed_net).toBe(1_150)
    expect(await bookVatSettlement(ctxOf(supabase), { period_type: 'quarterly', year: 2026, period: 2 }, { dryRun: true })).toMatchObject({ ok: true })
  })

  it('moves a settlement booked on the filing day to the quarter it settles', async () => {
    const q1Sale = sale('2026-02-15')
    const q1Settled = settlement('2026-05-12', { description: 'Moms Q1' })
    const q2Sale = entry('2026-05-15', [{ account_number: '1930', debit: 2_000 }, { account_number: '2611', credit: 2_000 }])
    const supabase = ledger({ fiscalPeriods: years, entries: [q1Sale, q1Settled, q2Sale], shaped: [q1Settled] })

    const q1 = await buildVatSettlementProposal(supabase, CO, 'quarterly', 2026, 1)
    expect(q1.existing_entries).toEqual([expect.objectContaining({ id: q1Settled.id, late_settlement: { cleared: 1_150, net: 1_150, via: 'net_account' } })])
    const q2 = await buildVatSettlementProposal(supabase, CO, 'quarterly', 2026, 2)
    expect(q2.existing_entries).toEqual([])
  })

  it('never takes the next quarter\'s own settlement for a quarter with the same VAT', async () => {
    const q1Sale = sale('2026-02-15')
    const q2Sale = sale('2026-05-15')
    const q2Settled = settlement('2026-06-30')
    const supabase = ledger({ fiscalPeriods: years, entries: [q1Sale, q2Sale, q2Settled], shaped: [q2Settled] })

    const q1 = await buildVatSettlementProposal(supabase, CO, 'quarterly', 2026, 1)
    expect(q1.existing_entries).toEqual([])
    const q2 = await buildVatSettlementProposal(supabase, CO, 'quarterly', 2026, 2)
    expect(q2.existing_entries.map((e) => e.id)).toEqual([q2Settled.id])
  })

  it('never takes a later quarter\'s late settlement when a quarter between has the same VAT', async () => {
    // Q2's momsredovisning is booked on its filing day in Q3; Q1 has the same VAT and was never settled.
    const q1Sale = sale('2026-02-15')
    const q2Sale = sale('2026-05-15')
    const q2Settled = settlement('2026-08-12')
    const supabase = ledger({ fiscalPeriods: years, entries: [q1Sale, q2Sale, q2Settled], shaped: [q2Settled] })

    const q1 = await buildVatSettlementProposal(supabase, CO, 'quarterly', 2026, 1)
    expect(q1.existing_entries).toEqual([])
    const q2 = await buildVatSettlementProposal(supabase, CO, 'quarterly', 2026, 2)
    expect(q2.existing_entries.map((e) => e.id)).toEqual([q2Settled.id])
  })

  it('keeps a quarter\'s own settlement when it no longer clears the quarter exactly but the quarter before was settled', async () => {
    // Q2's settlement cleared 1 150; an invoice dated in Q2 was added after it. Q1 (also 1 150) has its own.
    const q1Sale = sale('2026-02-15')
    const q1Settled = settlement('2026-03-31')
    const q2Sale = sale('2026-05-15')
    const q2Settled = settlement('2026-06-30')
    const q2Late = entry('2026-06-20', [{ account_number: '1930', debit: 400 }, { account_number: '2611', credit: 400 }])
    const supabase = ledger({ fiscalPeriods: years, entries: [q1Sale, q1Settled, q2Sale, q2Settled, q2Late], shaped: [q1Settled, q2Settled] })

    const q2 = await buildVatSettlementProposal(supabase, CO, 'quarterly', 2026, 2)
    expect(q2.existing_entries.map((e) => e.id)).toEqual([q2Settled.id])
    expect(await bookVatSettlement(ctxOf(supabase), { period_type: 'quarterly', year: 2026, period: 2 }, { dryRun: true })).toMatchObject({
      ok: false,
      code: 'VAT_SETTLEMENT_ALREADY_BOOKED',
    })
  })
})

describe('an opening balance in a quarterly momsredovisning (crm#1333)', () => {
  const years = calendarYears([], [2026])
  // A migration mid-year: the opening balance carries January's VAT (2611 500,
  // 2641 40), whose verifikat are not in the books.
  const openingBalance = (date: string) =>
    entry(date, [
      { account_number: '2641', debit: 40 },
      { account_number: '1930', debit: 460 },
      { account_number: '2611', credit: 500 },
    ], { source_type: 'opening_balance' })
  const march = entry('2026-03-10', [{ account_number: '1930', debit: 1_150 }, { account_number: '2641', debit: 100 }, { account_number: '2611', credit: 1_250 }])

  it('settles an opening balance dated inside the quarter with the quarter: it carries the quarter\'s own days', async () => {
    const supabase = ledger({ fiscalPeriods: years, entries: [openingBalance('2026-02-01'), march], shaped: [] })
    const q1 = await buildVatSettlementProposal(supabase, CO, 'quarterly', 2026, 1)
    expect(q1.filed_net).toBe(1_610)
  })

  it('leaves an opening balance dated on the quarter\'s first day out: it carries only earlier quarters', async () => {
    const supabase = ledger({ fiscalPeriods: years, entries: [openingBalance('2026-01-01'), march], shaped: [] })
    const q1 = await buildVatSettlementProposal(supabase, CO, 'quarterly', 2026, 1)
    expect(q1.filed_net).toBe(1_150)
  })

  it('leaves an opening balance inside the quarter out when the quarter\'s earlier days are in the books: no double count', async () => {
    // A räkenskapsår starting 1 February rolls its IB forward from the
    // books, which also hold January's own verifikat (2611 500, 2641 40).
    const january = entry('2026-01-20', [{ account_number: '1930', debit: 460 }, { account_number: '2641', debit: 40 }, { account_number: '2611', credit: 500 }])
    const supabase = ledger({ fiscalPeriods: years, entries: [january, openingBalance('2026-02-01'), march], shaped: [] })
    const q1 = await buildVatSettlementProposal(supabase, CO, 'quarterly', 2026, 1)
    expect(q1.filed_net).toBe(1_610)
  })
})
