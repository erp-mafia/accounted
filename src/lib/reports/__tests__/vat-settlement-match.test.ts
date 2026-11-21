/**
 * Which momsperiod a momsredovisning settles, read by amount (crm#1316), as
 * the proposal, the momsdeklaration card's status and the booking guard see
 * it. Run against one in-memory ledger (lib/measures/__tests__/fake-ledger):
 * the VAT totals RPC, its settlement shapes (stated per fixture, the SQL's
 * decision) and every table read are answered from the same entries.
 */
import { describe, expect, it, vi } from 'vitest'
import { createFakeLedger, type FakeEntry, type FakeLedgerData } from '@/lib/measures/__tests__/fake-ledger'
import { balanceLeftToClear, buildVatSettlementProposal, vatSettlementBookingStatus } from '../vat-settlement'
import { bookVatSettlement } from '../vat-settlement-booking'
import { partlySettledRestBooksAlone } from '@/lib/vat/partly-settled-rest'
import { momsredovisningShapeOfLines } from '@/lib/vat/voucher-vat-impact'

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
  { account_number: '2631', account_name: 'Utgående moms på försäljning inom Sverige, 6 %', account_class: 2 },
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

describe('a correction of an older period settled against the skattekonto inside a quarter (crm#1755)', () => {
  // The earlier year's declaration left out 80 of output VAT 6 %: the opening
  // balance carries it on 2631. Q1 and Q2 are settled on their last day. The
  // corrected declaration's difference is settled straight against the
  // skattekonto on 9 September, inside Q3 (2631 against 1630, no 2650).
  const ib = entry('2026-01-01', [{ account_number: '1930', debit: 80 }, { account_number: '2631', credit: 80 }], { source_type: 'opening_balance', description: 'Ingående balans' })
  const years: FakeLedgerData['fiscalPeriods'] = [
    { id: 'fp', period_start: '2026-01-01', period_end: '2026-12-31', is_closed: false, locked_at: null, opening_balance_entry_id: ib.id },
  ]
  const sale = (date: string) => entry(date, [{ account_number: '1930', debit: 1_150 }, { account_number: '2641', debit: 100 }, { account_number: '2611', credit: 1_250 }])
  const settlement = (date: string) =>
    entry(date, [{ account_number: '2611', debit: 1_250 }, { account_number: '2641', credit: 100 }, { account_number: '2650', credit: 1_150 }], { description: 'Momsredovisning' })
  const q1 = [sale('2026-02-15'), settlement('2026-03-31')]
  const q2 = [sale('2026-05-15'), settlement('2026-06-30')]
  // Q3: 2611 2 000, 2631 300, 2641 400: ruta 49 1 900.
  const q3Sale = entry('2026-08-15', [{ account_number: '1930', debit: 1_900 }, { account_number: '2641', debit: 400 }, { account_number: '2611', credit: 2_000 }, { account_number: '2631', credit: 300 }])
  const correction = entry('2026-09-09', [{ account_number: '2631', debit: 80 }, { account_number: '1630', credit: 80 }], { description: 'Rättad moms tidigare period' })
  const base = [ib, ...q1, ...q2, q3Sale]
  const settledBefore = [q1[1], q2[1]]

  it('leaves the quarter bookable: the difference clears what the books carried in, none of the quarter\'s own VAT', async () => {
    const supabase = ledger({ fiscalPeriods: years, entries: [...base, correction], shaped: [...settledBefore, correction] })
    const proposal = await buildVatSettlementProposal(supabase, CO, 'quarterly', 2026, 3)
    expect(proposal.existing_entries).toEqual([])
    expect(vatSettlementBookingStatus(proposal.existing_entries)).toBe('none')
    // The proposal clears the quarter's own 2631, not what the correction moved.
    expect(proposal.lines).toEqual(expect.arrayContaining([expect.objectContaining({ account_number: '2631', debit_amount: 300, credit_amount: 0 })]))
    expect(proposal.filed_net).toBe(1_900)
    expect(await bookVatSettlement(ctxOf(supabase), { period_type: 'quarterly', year: 2026, period: 3 }, { dryRun: true })).toMatchObject({ ok: true, dryRun: true })
  })

  it('names the quarter\'s own momsredovisning, not the difference, once it is booked', async () => {
    const own = entry('2026-09-30', [
      { account_number: '2611', debit: 2_000 },
      { account_number: '2631', debit: 300 },
      { account_number: '2641', credit: 400 },
      { account_number: '2650', credit: 1_900 },
    ], { description: 'Momsredovisning Q3' })
    const supabase = ledger({ fiscalPeriods: years, entries: [...base, correction, own], shaped: [...settledBefore, correction, own] })
    const proposal = await buildVatSettlementProposal(supabase, CO, 'quarterly', 2026, 3)
    expect(proposal.existing_entries.map((e) => e.id)).toEqual([own.id])
    expect(await bookVatSettlement(ctxOf(supabase), { period_type: 'quarterly', year: 2026, period: 3 }, { dryRun: true })).toMatchObject({
      ok: false,
      code: 'VAT_SETTLEMENT_ALREADY_BOOKED',
      details: { journal_entry_id: own.id },
    })
  })

  it('also when the previous quarter\'s momsredovisning is booked on its filing day inside the quarter', async () => {
    // Q2 holds 60 of 2631 too and is settled on 17 August: what the books
    // carry into Q3 on 2631 is 140, of which Q2's own settlement clears 60.
    const q2Sale = entry('2026-05-15', [{ account_number: '1930', debit: 1_210 }, { account_number: '2641', debit: 100 }, { account_number: '2611', credit: 1_250 }, { account_number: '2631', credit: 60 }])
    const q2Settled = entry('2026-08-17', [{ account_number: '2611', debit: 1_250 }, { account_number: '2631', debit: 60 }, { account_number: '2641', credit: 100 }, { account_number: '2650', credit: 1_210 }], { description: 'Moms Q2' })
    const supabase = ledger({ fiscalPeriods: years, entries: [ib, ...q1, q2Sale, q2Settled, q3Sale, correction], shaped: [q1[1], q2Settled, correction] })
    const proposal = await buildVatSettlementProposal(supabase, CO, 'quarterly', 2026, 3)
    expect(proposal.existing_entries).toEqual([])
    const q2 = await buildVatSettlementProposal(supabase, CO, 'quarterly', 2026, 2)
    expect(q2.existing_entries).toEqual([expect.objectContaining({ id: q2Settled.id, late_settlement: expect.objectContaining({ cleared: 1_210 }) })])
  })

  it('keeps gating when the verifikat clears neither the quarter\'s VAT nor exactly what the books carried in', async () => {
    const partial = entry('2026-09-09', [{ account_number: '2631', debit: 50 }, { account_number: '1630', credit: 50 }])
    const supabase = ledger({ fiscalPeriods: years, entries: [...base, partial], shaped: [...settledBefore, partial] })
    const proposal = await buildVatSettlementProposal(supabase, CO, 'quarterly', 2026, 3)
    expect(proposal.existing_entries.map((e) => e.id)).toEqual([partial.id])
  })

  it('keeps the quarter\'s own momsredovisning when the quarter before, with the same VAT, is still unsettled', async () => {
    // What the books carry into Q3 on 2611 and 2641 equals Q3's own VAT: the
    // verifikat clears Q3 in full, so it is Q3's.
    const q3SameSale = sale('2026-08-15')
    const own = settlement('2026-09-30')
    const supabase = ledger({ fiscalPeriods: years, entries: [ib, ...q1, q2[0], q3SameSale, own], shaped: [q1[1], own] })
    const proposal = await buildVatSettlementProposal(supabase, CO, 'quarterly', 2026, 3)
    expect(proposal.existing_entries.map((e) => e.id)).toEqual([own.id])
  })

  it('still gates a momsredovisning booked straight against the skattekonto (#984)', async () => {
    const own = entry('2026-09-30', [
      { account_number: '2611', debit: 2_000 },
      { account_number: '2631', debit: 300 },
      { account_number: '2641', credit: 400 },
      { account_number: '1630', credit: 1_900 },
    ])
    const supabase = ledger({ fiscalPeriods: years, entries: [...base, own], shaped: [...settledBefore, own] })
    const proposal = await buildVatSettlementProposal(supabase, CO, 'quarterly', 2026, 3)
    expect(proposal.existing_entries.map((e) => e.id)).toEqual([own.id])
    expect(await bookVatSettlement(ctxOf(supabase), { period_type: 'quarterly', year: 2026, period: 3 }, { dryRun: true })).toMatchObject({
      ok: false,
      code: 'VAT_SETTLEMENT_ALREADY_BOOKED',
      details: { journal_entry_id: own.id },
    })
  })

  it('still gates one that no longer clears any account in full after a verifikat was added on every account it cleared', async () => {
    const own = entry('2026-09-30', [
      { account_number: '2611', debit: 2_000 },
      { account_number: '2631', debit: 300 },
      { account_number: '2641', credit: 400 },
      { account_number: '1630', credit: 1_900 },
    ])
    const added = entry('2026-09-20', [{ account_number: '1930', debit: 480 }, { account_number: '2641', debit: 50 }, { account_number: '2611', credit: 500 }, { account_number: '2631', credit: 30 }])
    const supabase = ledger({ fiscalPeriods: years, entries: [...base, own, added], shaped: [...settledBefore, own] })
    const proposal = await buildVatSettlementProposal(supabase, CO, 'quarterly', 2026, 3)
    expect(proposal.existing_entries.map((e) => e.id)).toEqual([own.id])
  })

  it('still gates a momsredovisning split in two verifikat, output and input VAT apart', async () => {
    const output = entry('2026-09-30', [{ account_number: '2611', debit: 2_000 }, { account_number: '2631', debit: 300 }, { account_number: '1630', credit: 2_300 }], { description: 'Utgående moms Q3' })
    const input = entry('2026-09-30', [{ account_number: '1630', debit: 400 }, { account_number: '2641', credit: 400 }], { description: 'Ingående moms Q3' })
    const supabase = ledger({ fiscalPeriods: years, entries: [...base, output, input], shaped: [...settledBefore, output, input] })
    const proposal = await buildVatSettlementProposal(supabase, CO, 'quarterly', 2026, 3)
    expect(proposal.existing_entries.map((e) => e.id).sort()).toEqual([output.id, input.id].sort())
    expect(await bookVatSettlement(ctxOf(supabase), { period_type: 'quarterly', year: 2026, period: 3 }, { dryRun: true })).toMatchObject({
      ok: false,
      code: 'VAT_SETTLEMENT_ALREADY_BOOKED',
    })
  })

  it('still gates a quarter settled month by month', async () => {
    const month = (date: string, vat: number) => [
      entry(date, [{ account_number: '1930', debit: vat * 5 }, { account_number: '2611', credit: vat }, { account_number: '3001', credit: vat * 4 }]),
      entry(date.replace(/-\d\d$/, '-28'), [{ account_number: '2611', debit: vat }, { account_number: '2650', credit: vat }], { description: 'Momsredovisning månad' }),
    ]
    const [july, julySettled] = month('2026-07-10', 600)
    const [august, augustSettled] = month('2026-08-10', 700)
    const [september, septemberSettled] = month('2026-09-10', 700)
    const supabase = ledger({
      fiscalPeriods: years,
      entries: [ib, ...q1, ...q2, july, julySettled, august, augustSettled, september, septemberSettled],
      shaped: [...settledBefore, julySettled, augustSettled, septemberSettled],
    })
    const proposal = await buildVatSettlementProposal(supabase, CO, 'quarterly', 2026, 3)
    expect(proposal.existing_entries.map((e) => e.id).sort()).toEqual([julySettled.id, augustSettled.id, septemberSettled.id].sort())
    expect(vatSettlementBookingStatus(proposal.existing_entries)).toBe('booked')
  })

  it('never counts the payment of the net on 2650 as the quarter\'s momsredovisning', async () => {
    // Q2's net paid to the skattekonto in August: 2650 against 1630 has no
    // declaration account, so it is no momsredovisning by shape (pinned in
    // tests/pg/vat-skattekonto-counter-entries.pg.test.ts), though it clears 2650.
    const transfer = entry('2026-08-10', [{ account_number: '1630', debit: 1_150 }, { account_number: '1930', credit: 1_150 }])
    const paid = entry('2026-08-12', [{ account_number: '2650', debit: 1_150 }, { account_number: '1630', credit: 1_150 }], { description: 'Moms Q2 betald' })
    const supabase = ledger({ fiscalPeriods: years, entries: [...base, transfer, paid], shaped: settledBefore })
    const proposal = await buildVatSettlementProposal(supabase, CO, 'quarterly', 2026, 3)
    expect(proposal.existing_entries).toEqual([])
    expect(proposal.filed_net).toBe(1_900)
    expect(await bookVatSettlement(ctxOf(supabase), { period_type: 'quarterly', year: 2026, period: 3 }, { dryRun: true })).toMatchObject({ ok: true })
  })
})

describe('a momsredovisning inside the period that cleared only part of it (crm#1855)', () => {
  // The books carry 600 of input VAT on 2641 into Q3. Q3 adds 70 of its own
  // and a reverse-charge purchase (2645 against 2614, 500.50). A settlement
  // that came with an import, dated 31 August, clears all of 2641 (the 600
  // carried in and Q3's 70) to 1650 and nothing else.
  const ib = entry('2026-01-01', [{ account_number: '2641', debit: 600 }, { account_number: '1930', credit: 600 }], { source_type: 'opening_balance', description: 'Ingående balans' })
  const years: FakeLedgerData['fiscalPeriods'] = [
    { id: 'fp', period_start: '2026-01-01', period_end: '2026-12-31', is_closed: false, locked_at: null, opening_balance_entry_id: ib.id },
  ]
  const purchase = entry('2026-07-02', [{ account_number: '2641', debit: 70 }, { account_number: '1930', credit: 70 }])
  const reverseCharge = entry('2026-09-15', [{ account_number: '2645', debit: 500.5 }, { account_number: '2614', credit: 500.5 }])
  const imported = entry('2026-08-31', [{ account_number: '1650', debit: 670 }, { account_number: '2641', credit: 670 }], { description: 'Omföring moms', source_type: 'import' })
  const q3 = [ib, purchase, reverseCharge]

  it('proposes only what is left on the accounts, never again what the settlement moved', async () => {
    const supabase = ledger({ fiscalPeriods: years, entries: [...q3, imported], shaped: [imported] })
    const proposal = await buildVatSettlementProposal(supabase, CO, 'quarterly', 2026, 3)
    expect(proposal.filed_net).toBe(-70)
    expect(proposal.partly_settled).toBe(true)
    // 2641 is at zero in the books: no line for it, and no 1650 line, the 70 is already there.
    expect(proposal.lines).toEqual([
      { account_number: '2614', debit_amount: 500.5, credit_amount: 0 },
      { account_number: '2645', debit_amount: 0, credit_amount: 500.5 },
    ])
    expect(proposal.rounding_amount).toBe(0)
    expect(proposal.is_empty).toBe(false)
  })

  it('still names the settlement and refuses a second booking (#984)', async () => {
    const supabase = ledger({ fiscalPeriods: years, entries: [...q3, imported], shaped: [imported] })
    const proposal = await buildVatSettlementProposal(supabase, CO, 'quarterly', 2026, 3)
    expect(proposal.existing_entries.map((e) => e.id)).toEqual([imported.id])
    expect(vatSettlementBookingStatus(proposal.existing_entries)).toBe('booked')
    expect(await bookVatSettlement(ctxOf(supabase), { period_type: 'quarterly', year: 2026, period: 3 }, { dryRun: true })).toMatchObject({
      ok: false,
      code: 'VAT_SETTLEMENT_ALREADY_BOOKED',
      details: { journal_entry_id: imported.id },
    })
  })

  it('is the full period, unchanged, while no momsredovisning is posted for it, and reads no settlement lines', async () => {
    const supabase = ledger({ fiscalPeriods: years, entries: q3, shaped: [] })
    const from = vi.spyOn(supabase, 'from')
    const proposal = await buildVatSettlementProposal(supabase, CO, 'quarterly', 2026, 3)
    expect(proposal.partly_settled).toBe(false)
    expect(proposal.existing_entries).toEqual([])
    expect(proposal.lines).toEqual([
      { account_number: '2614', debit_amount: 500.5, credit_amount: 0 },
      { account_number: '2641', debit_amount: 0, credit_amount: 70 },
      { account_number: '2645', debit_amount: 0, credit_amount: 500.5 },
      { account_number: '1650', debit_amount: 70, credit_amount: 0, line_description: 'Moms att återfå' },
    ])
    // The remainder is computed from the posted settlements' lines only: with
    // none, the lines are never read and the proposal is built as before.
    expect(from.mock.calls.filter(([table]) => table === 'journal_entry_lines')).toEqual([])
  })

  it('is the full period, unchanged, when the settlement cleared it in full', async () => {
    const full = entry('2026-09-30', [
      { account_number: '2614', debit: 500.5 },
      { account_number: '1650', debit: 70 },
      { account_number: '2641', credit: 70 },
      { account_number: '2645', credit: 500.5 },
    ], { description: 'Momsredovisning Q3' })
    const supabase = ledger({ fiscalPeriods: years, entries: [...q3, full], shaped: [full] })
    const proposal = await buildVatSettlementProposal(supabase, CO, 'quarterly', 2026, 3)
    expect(proposal.partly_settled).toBe(false)
    expect(proposal.existing_entries.map((e) => e.id)).toEqual([full.id])
    expect(proposal.lines).toHaveLength(4)
    expect(proposal.lines).toContainEqual({ account_number: '2641', debit_amount: 0, credit_amount: 70 })
  })

  it('is the full period, unchanged, when the settlement was booked by the app itself', async () => {
    const tagged = entry('2026-09-30', [
      { account_number: '2614', debit: 500.5 },
      { account_number: '1650', debit: 70 },
      { account_number: '2641', credit: 70 },
      { account_number: '2645', credit: 500.5 },
    ], { description: 'Momsredovisning Kvartal 3 2026', source_type: 'vat_settlement' })
    const supabase = ledger({ fiscalPeriods: years, entries: [...q3, tagged], shaped: [] })
    const proposal = await buildVatSettlementProposal(supabase, CO, 'quarterly', 2026, 3)
    expect(proposal.partly_settled).toBe(false)
    expect(proposal.lines).toHaveLength(4)
    expect(vatSettlementBookingStatus(proposal.existing_entries)).toBe('booked')
  })

  it('proposes the verifikat added after the period was settled, with the net it adds', async () => {
    // Settled in full on the last day; a sale dated in Q3 (2611 400.40) is added afterwards.
    const full = entry('2026-09-30', [
      { account_number: '2614', debit: 500.5 },
      { account_number: '1650', debit: 70 },
      { account_number: '2641', credit: 70 },
      { account_number: '2645', credit: 500.5 },
    ], { description: 'Momsredovisning Q3' })
    const added = entry('2026-09-20', [{ account_number: '1930', debit: 400.4 }, { account_number: '2611', credit: 400.4 }])
    const supabase = ledger({ fiscalPeriods: years, entries: [...q3, full, added], shaped: [full] })
    const proposal = await buildVatSettlementProposal(supabase, CO, 'quarterly', 2026, 3)
    // Ruta 49 is now 330 (400.40 less 70, öre dropped); the settlement moved -70 of it.
    expect(proposal.filed_net).toBe(330)
    expect(proposal.partly_settled).toBe(true)
    expect(proposal.lines).toEqual([
      { account_number: '2611', debit_amount: 400.4, credit_amount: 0 },
      { account_number: '2650', debit_amount: 0, credit_amount: 400, line_description: 'Moms att betala' },
      { account_number: '3740', debit_amount: 0, credit_amount: 0.4, line_description: 'Öres- och kronutjämning' },
    ])
    expect(vatSettlementBookingStatus(proposal.existing_entries)).toBe('booked')
  })
})

describe('a supplier invoice dated in the period after the app booked its momsredovisning (#3570)', () => {
  // Q3 2026: a sale with 250 of output VAT, settled by the app on 30 September
  // (2611 against 2650), then a purchase dated 20 September with 250 of input
  // VAT. Ruta 49 is now 0 and 2641 is not cleared: the Moms page reads
  // partly_settled and these lines to say so instead of "already booked".
  const years: FakeLedgerData['fiscalPeriods'] = [
    { id: 'fp', period_start: '2026-01-01', period_end: '2026-12-31', is_closed: false, locked_at: null, opening_balance_entry_id: null },
  ]
  const sale = entry('2026-07-15', [{ account_number: '1510', debit: 1_250 }, { account_number: '3001', credit: 1_000 }, { account_number: '2611', credit: 250 }])
  const settled = entry('2026-09-30', [{ account_number: '2611', debit: 250 }, { account_number: '2650', credit: 250 }], {
    description: 'Momsredovisning Kvartal 3 2026',
    source_type: 'vat_settlement',
  })
  const invoice = entry('2026-09-20', [{ account_number: '5010', debit: 1_000 }, { account_number: '2641', debit: 250 }, { account_number: '2440', credit: 1_250 }])

  it('is fully booked before the invoice', async () => {
    const supabase = ledger({ fiscalPeriods: years, entries: [sale, settled], shaped: [] })
    const proposal = await buildVatSettlementProposal(supabase, CO, 'quarterly', 2026, 3)
    expect(proposal.partly_settled).toBe(false)
    expect(vatSettlementBookingStatus(proposal.existing_entries)).toBe('booked')
  })

  it('is partly settled after it, with the input VAT left as the lines to book', async () => {
    const supabase = ledger({ fiscalPeriods: years, entries: [sale, settled, invoice], shaped: [] })
    const proposal = await buildVatSettlementProposal(supabase, CO, 'quarterly', 2026, 3)
    expect(proposal.filed_net).toBe(0)
    expect(proposal.partly_settled).toBe(true)
    expect(proposal.lines).toEqual([
      { account_number: '2641', debit_amount: 0, credit_amount: 250 },
      { account_number: '1650', debit_amount: 250, credit_amount: 0, line_description: 'Moms att återfå' },
    ])
    expect(vatSettlementBookingStatus(proposal.existing_entries)).toBe('booked')
    // The page offers booking them alone, dated the period's last day: with
    // their 1650 line they have the momsredovisning shape the rutor skip.
    expect(proposal.entry_date).toBe('2026-09-30')
    expect(partlySettledRestBooksAlone(proposal)).toBe(true)
    expect(momsredovisningShapeOfLines(proposal.lines.map((l) => l.account_number), ['1630'])).toBe('net_account_shape')
    // Past a lock date they cannot be dated inside the period: only reversing is offered.
    expect(partlySettledRestBooksAlone({ ...proposal, entry_date: '2026-10-01', entry_date_reason: 'company_lock_date' })).toBe(false)
  })

  it('offers only reversing when the rest nets to zero, as an EU service purchase does', async () => {
    // Reverse charge on an EU service (2614 credit, 2645 debit) leaves no net
    // for 2650/1650. Posted alone, 26xx lines with no 2650/1650 or skattekonto
    // line are no momsredovisning shape, so the rutor would read them as
    // business: ruta 30 and ruta 48 would each drop by 250.
    const euService = entry('2026-09-20', [
      { account_number: '4535', debit: 1_000 },
      { account_number: '2614', credit: 250 },
      { account_number: '2645', debit: 250 },
      { account_number: '2440', credit: 1_000 },
    ])
    const supabase = ledger({ fiscalPeriods: years, entries: [sale, settled, euService], shaped: [] })
    const proposal = await buildVatSettlementProposal(supabase, CO, 'quarterly', 2026, 3)
    expect(proposal.partly_settled).toBe(true)
    expect(proposal.lines).toEqual([
      { account_number: '2614', debit_amount: 250, credit_amount: 0 },
      { account_number: '2645', debit_amount: 0, credit_amount: 250 },
    ])
    expect(momsredovisningShapeOfLines(proposal.lines.map((l) => l.account_number), ['1630'])).toBeNull()
    expect(partlySettledRestBooksAlone(proposal)).toBe(false)
  })

  it('is fully booked again once those lines are posted as a verifikat of their own', async () => {
    const rest = entry('2026-09-30', [{ account_number: '2641', credit: 250 }, { account_number: '1650', debit: 250 }], { description: 'Moms kvar Q3' })
    const supabase = ledger({ fiscalPeriods: years, entries: [sale, settled, invoice, rest], shaped: [rest] })
    const proposal = await buildVatSettlementProposal(supabase, CO, 'quarterly', 2026, 3)
    expect(proposal.partly_settled).toBe(false)
    expect(proposal.existing_entries.map((e) => e.id).sort()).toEqual([settled.id, rest.id].sort())
  })
})

describe('balanceLeftToClear', () => {
  it('takes what the settlements cleared off the period balance', () => {
    expect(balanceLeftToClear(1_650, 1_250)).toBe(400)
    expect(balanceLeftToClear(-400, -150)).toBe(-250)
  })

  it('leaves nothing, never the other side, when more than the period balance was cleared', () => {
    expect(balanceLeftToClear(-70, -670)).toBe(0)
    expect(balanceLeftToClear(300, 380)).toBe(0)
  })

  it('leaves the period balance when the verifikat moved the account the other way', () => {
    expect(balanceLeftToClear(300, -80)).toBe(300)
    expect(balanceLeftToClear(-70, 25)).toBe(-70)
  })

  it('leaves nothing on an account the period did not touch', () => {
    expect(balanceLeftToClear(0, 80)).toBe(0)
  })
})
