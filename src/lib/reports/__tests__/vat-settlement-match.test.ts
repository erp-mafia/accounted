/**
 * Which momsperiod a momsredovisning settles, read by amount (crm#1316), as
 * the proposal, the momsdeklaration card's status and the booking guard see
 * it. Run against one in-memory ledger (lib/measures/__tests__/fake-ledger):
 * the VAT totals RPC, its settlement shapes (stated per fixture, the SQL's
 * decision) and every table read are answered from the same entries.
 */
import { describe, expect, it, vi } from 'vitest'
import { createFakeLedger, type FakeEntry, type FakeLedgerData } from '@/lib/measures/__tests__/fake-ledger'
import {
  balanceLeftToClear,
  buildVatSettlementProposal,
  postedVatSettlements,
  vatSettlementBookingStatus,
  type VatSettlementProposalLine,
} from '../vat-settlement'
import { settlementAccountDrift, type SettlementEntryRow } from '../vat-settlement-account-drift'
import { bookVatSettlement } from '../vat-settlement-booking'
import { partlySettledRestBooksAlone } from '@/lib/vat/partly-settled-rest'
import { momsredovisningShapeOfLines } from '@/lib/vat/voucher-vat-impact'
import { roundOre } from '@/lib/money'

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
  /** The filing record's rows: a completed moms deadline per filed period. */
  filings?: Array<Record<string, unknown>>
}) {
  return createFakeLedger({
    companyId: CO,
    fiscalPeriods: options.fiscalPeriods,
    chart: CHART,
    entries: options.entries,
    vatShapedEntryIds: options.shaped.map((e) => e.id),
    extraTables: {
      company_settings: [{ company_id: CO, accounting_method: 'accrual', bookkeeping_locked_through: options.lockedThrough ?? null }],
      deadlines: options.filings ?? [],
    },
  }).supabase
}

/** Q3 2026's momsdeklaration on record as filed through Skatteverket. */
const FILED_Q3 = {
  id: 'dl-2026-q3',
  company_id: CO,
  tax_deadline_type: 'moms_quarterly',
  tax_period: '2026-Q3',
  is_completed: true,
  completed_at: '2026-11-05T09:00:00Z',
  status: 'confirmed',
  notes: null,
  due_date: '2026-11-12',
  dismissed_at: null,
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

/** A proposal's lines as a fixture entry's. */
function asLines(lines: readonly VatSettlementProposalLine[]): FakeEntry['lines'] {
  return lines.map((l) => ({ account_number: l.account_number, debit: l.debit_amount, credit: l.credit_amount }))
}

/** What the lines leave on 2650 (credit, att betala) and 1650 (debit, att återfå) together. */
function netAccountsAfter(posted: FakeEntry['lines'], rest: readonly VatSettlementProposalLine[]): Record<'2650' | '1650', number> {
  const out = { '2650': 0, '1650': 0 }
  for (const l of [...posted, ...asLines(rest)]) {
    if (l.account_number === '2650') out['2650'] = roundOre(out['2650'] + (l.credit ?? 0) - (l.debit ?? 0))
    if (l.account_number === '1650') out['1650'] = roundOre(out['1650'] + (l.debit ?? 0) - (l.credit ?? 0))
  }
  return out
}

/** What 2650 and 1650 hold together: owed to Skatteverket, less what it owes back. */
function positionOf(accounts: Record<'2650' | '1650', number>): number {
  return roundOre(accounts['2650'] - accounts['1650'])
}

/**
 * A rest booked as a verifikat of its own on the period's last day. Its
 * lines have the momsredovisning shape the rutor skip (the TypeScript
 * restatement, pinned to the SQL in tests/pg/voucher-vat-impact-shapes.pg.test.ts),
 * so a fixture may state it shaped.
 */
function restEntry(lines: readonly VatSettlementProposalLine[]): FakeEntry {
  expect(momsredovisningShapeOfLines(lines.map((l) => l.account_number), ['1630'])).toBe('net_account_shape')
  return entry('2026-09-30', asLines(lines), { description: 'Moms kvar Q3' })
}

/** What the lines leave on 3740, credit minus debit. */
function roundingAfter(lines: FakeEntry['lines']): number {
  return lines.reduce((sum, l) => (l.account_number === '3740' ? roundOre(sum + (l.credit ?? 0) - (l.debit ?? 0)) : sum), 0)
}

/** The 2650/1650 lines of a verifikat dated the quarter's last day, as the drift check reads them. */
function driftRows(id: string, lines: FakeEntry['lines']): SettlementEntryRow[] {
  return lines
    .filter((l) => l.account_number === '2650' || l.account_number === '1650')
    .map((l) => ({
      account_number: l.account_number,
      entry_date: '2026-09-30',
      debit: l.debit ?? 0,
      credit: l.credit ?? 0,
      journal_entry_id: id,
      voucher_label: id,
      opening_balance: false,
      cancelled: false,
    }))
}

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
    // The 400 more to pay first takes back the 70 the settlement put on 1650
    // (#3646): 2650 C 400 beside 1650 D 70 would never clear, Skatteverket
    // charges the 330 net.
    expect(proposal.lines).toEqual([
      { account_number: '2611', debit_amount: 400.4, credit_amount: 0 },
      { account_number: '1650', debit_amount: 0, credit_amount: 70, line_description: 'Moms att återfå' },
      { account_number: '2650', debit_amount: 0, credit_amount: 330, line_description: 'Moms att betala' },
      { account_number: '3740', debit_amount: 0, credit_amount: 0.4, line_description: 'Öres- och kronutjämning' },
    ])
    expect(vatSettlementBookingStatus(proposal.existing_entries)).toBe('booked')
    // Booked with the settlement, the two end where one momsredovisning for the whole quarter puts them.
    const once = await buildVatSettlementProposal(ledger({ fiscalPeriods: years, entries: [...q3, added], shaped: [] }), CO, 'quarterly', 2026, 3)
    expect(netAccountsAfter(full.lines, proposal.lines)).toEqual(netAccountsAfter([], once.lines))
    expect(netAccountsAfter(full.lines, proposal.lines)).toEqual({ '2650': 330, '1650': 0 })
  })

  it('adds a net to get back to the claim the settlement put on 1650, so one refund clears it', async () => {
    const full = entry('2026-09-30', [
      { account_number: '2614', debit: 500.5 },
      { account_number: '1650', debit: 70 },
      { account_number: '2641', credit: 70 },
      { account_number: '2645', credit: 500.5 },
    ], { description: 'Momsredovisning Q3' })
    const added = entry('2026-09-20', [{ account_number: '5010', debit: 120 }, { account_number: '2641', debit: 30 }, { account_number: '1930', credit: 150 }])
    const proposal = await buildVatSettlementProposal(ledger({ fiscalPeriods: years, entries: [...q3, full, added], shaped: [full] }), CO, 'quarterly', 2026, 3)
    expect(proposal.filed_net).toBe(-100)
    // Expected entry: 2641 C 30 / 1650 D 30. 1650 then holds the 100 ruta 49 gets back.
    expect(proposal.lines).toEqual([
      { account_number: '2641', debit_amount: 0, credit_amount: 30 },
      { account_number: '1650', debit_amount: 30, credit_amount: 0, line_description: 'Moms att återfå' },
    ])
    expect(netAccountsAfter(full.lines, proposal.lines)).toEqual({ '2650': 0, '1650': 100 })
  })

  it('takes back no more than the claim the settlement put on 1650, the balance carried in included (#3646)', async () => {
    // The import's settlement put 670 on 1650: Q3's 70 and the 600 carried
    // in on 2641. Then a sale with 400.40 of output VAT: ruta 49 is 330.
    const sale = entry('2026-09-20', [{ account_number: '1930', debit: 400.4 }, { account_number: '2611', credit: 400.4 }])
    const entries = [...q3, imported, sale]
    const proposal = await buildVatSettlementProposal(ledger({ fiscalPeriods: years, entries, shaped: [imported] }), CO, 'quarterly', 2026, 3)
    expect(proposal.filed_net).toBe(330)
    expect(proposal.partly_settled).toBe(true)
    // Expected entry: the sale and the reverse charge cleared, 1650 C 400, the 0.40 on 3740.
    expect(proposal.lines).toEqual([
      { account_number: '2611', debit_amount: 400.4, credit_amount: 0 },
      { account_number: '2614', debit_amount: 500.5, credit_amount: 0 },
      { account_number: '2645', debit_amount: 0, credit_amount: 500.5 },
      { account_number: '1650', debit_amount: 0, credit_amount: 400, line_description: 'Moms att återfå' },
      { account_number: '3740', debit_amount: 0, credit_amount: 0.4, line_description: 'Öres- och kronutjämning' },
    ])
    // 1650 ends on a 270 claim, 2650 on nothing: the rest books no debt
    // beside a claim. By sign it would be 2650 C 400 beside 1650 D 670.
    expect(netAccountsAfter(imported.lines, proposal.lines)).toEqual({ '2650': 0, '1650': 270 })
    // Filed, the period's own 70 stays for Skatteverket's refund of it, and
    // the 400 still comes off the 600 carried in: the same lines.
    const filed = await buildVatSettlementProposal(ledger({ fiscalPeriods: years, entries, shaped: [imported], filings: [FILED_Q3] }), CO, 'quarterly', 2026, 3)
    expect(filed.lines).toEqual(proposal.lines)
    // Booked alone, the period reads settled and ruta 49 is still 330.
    expect(partlySettledRestBooksAlone(proposal)).toBe(true)
    const rest = restEntry(proposal.lines)
    const after = await buildVatSettlementProposal(ledger({ fiscalPeriods: years, entries: [...entries, rest], shaped: [imported, rest] }), CO, 'quarterly', 2026, 3)
    expect(after.partly_settled).toBe(false)
    expect(after.filed_net).toBe(330)
  })

  it('leaves the öre of a balance carried in out of the net, so 2650 stays in whole kronor', async () => {
    // Q2's 100.30 of input VAT was never settled. Q3's own momsredovisning
    // cleared it with Q3's sale: 2650 C 399, the 0.70 on 3740. Then 100 more
    // of output VAT: ruta 49 goes from 500 to 600.
    const q2 = entry('2026-05-10', [{ account_number: '5010', debit: 401.2 }, { account_number: '2641', debit: 100.3 }, { account_number: '2440', credit: 501.5 }])
    const sold = entry('2026-07-15', [{ account_number: '1930', debit: 2_500 }, { account_number: '3001', credit: 2_000 }, { account_number: '2611', credit: 500 }])
    const manual = entry('2026-09-30', [
      { account_number: '2611', debit: 500 },
      { account_number: '2641', credit: 100.3 },
      { account_number: '2650', credit: 399 },
      { account_number: '3740', credit: 0.7 },
    ], { description: 'Momsredovisning Kvartal 3 2026', source_type: 'vat_settlement' })
    const more = entry('2026-09-20', [{ account_number: '1930', debit: 500 }, { account_number: '3001', credit: 400 }, { account_number: '2611', credit: 100 }])
    const proposal = await buildVatSettlementProposal(ledger({ fiscalPeriods: years, entries: [ib, q2, sold, manual, more], shaped: [] }), CO, 'quarterly', 2026, 3)
    expect(proposal.filed_net).toBe(600)
    // Expected entry: 2611 D 100 / 2650 C 100, no 3740 line: 2650 ends on 499.
    expect(proposal.lines).toEqual([
      { account_number: '2611', debit_amount: 100, credit_amount: 0 },
      { account_number: '2650', debit_amount: 0, credit_amount: 100, line_description: 'Moms att betala' },
    ])
    expect(netAccountsAfter(manual.lines, proposal.lines)).toEqual({ '2650': 499, '1650': 0 })
  })
})

describe('a refund period whose rest comes before or after its declaration is filed (#3646)', () => {
  // Q3 2026 with input VAT only, settled by the app to 1650. Skatteverket's
  // rows are booked as the skattekonto booking's moms rule books them: a
  // charge and a correction on 2650, a refund on 1650 only when 1650 holds
  // exactly that claim.
  const years: FakeLedgerData['fiscalPeriods'] = [
    { id: 'fp', period_start: '2026-01-01', period_end: '2026-12-31', is_closed: false, locked_at: null, opening_balance_entry_id: null },
  ]
  const purchase = (date: string, vat: number) =>
    entry(date, [{ account_number: '5010', debit: vat * 4 }, { account_number: '2641', debit: vat }, { account_number: '2440', credit: vat * 5 }])
  const settledClaim = (vat: number) =>
    entry('2026-09-30', [{ account_number: '2641', credit: vat }, { account_number: '1650', debit: vat }], {
      description: 'Momsredovisning Kvartal 3 2026',
      source_type: 'vat_settlement',
    })
  const sale = (vat: number) => entry('2026-09-25', [{ account_number: '1930', debit: vat * 5 }, { account_number: '3001', credit: vat * 4 }, { account_number: '2611', credit: vat }])
  const skv = (amount: number, account: '2650' | '1650') =>
    amount > 0
      ? [{ account_number: '1630', debit: amount }, { account_number: account, credit: amount }]
      : [{ account_number: account, debit: -amount }, { account_number: '1630', credit: -amount }]

  it('takes the claim back before the period is filed: one charge then clears it', async () => {
    const bought = purchase('2026-07-20', 100)
    const settled = settledClaim(100)
    const proposal = await buildVatSettlementProposal(ledger({ fiscalPeriods: years, entries: [bought, settled, sale(250)], shaped: [] }), CO, 'quarterly', 2026, 3)
    expect(proposal.filed_net).toBe(150)
    // Expected entry: 2611 D 250 / 1650 C 100 / 2650 C 150.
    expect(proposal.lines).toEqual([
      { account_number: '2611', debit_amount: 250, credit_amount: 0 },
      { account_number: '1650', debit_amount: 0, credit_amount: 100, line_description: 'Moms att återfå' },
      { account_number: '2650', debit_amount: 0, credit_amount: 150, line_description: 'Moms att betala' },
    ])
    // The declaration filed once charges 150, on 2650: both accounts end on nothing.
    expect(netAccountsAfter([...settled.lines, ...skv(-150, '2650')], proposal.lines)).toEqual({ '2650': 0, '1650': 0 })
  })

  it('leaves a claim already refunded alone once the period is filed (review of #3647)', async () => {
    const bought = purchase('2026-07-20', 100)
    const settled = settledClaim(100)
    // Filed at -100; the refund matched 1650 and cleared it.
    const refunded = entry('2026-11-12', skv(100, '1650'), { description: 'Moms juli-sept 2026' })
    const entries = [bought, settled, refunded, sale(250)]
    const proposal = await buildVatSettlementProposal(ledger({ fiscalPeriods: years, entries, shaped: [], filings: [FILED_Q3] }), CO, 'quarterly', 2026, 3)
    // Expected entry: 2611 D 250 / 2650 C 250, the correction on its own.
    expect(proposal.lines).toEqual([
      { account_number: '2611', debit_amount: 250, credit_amount: 0 },
      { account_number: '2650', debit_amount: 0, credit_amount: 250, line_description: 'Moms att betala' },
    ])
    // Skatteverket's decision on the corrected declaration debits 250 on 2650: nothing is left.
    expect(netAccountsAfter([...settled.lines, ...refunded.lines, ...skv(-250, '2650')], proposal.lines)).toEqual({ '2650': 0, '1650': 0 })
    // Taking the 100 back as well would end on 2650 D 100 beside 1650 C 100.
  })

  it('leaves a claim whose refund is still to come on 1650 once the period is filed (review of #3647)', async () => {
    const bought = purchase('2026-07-20', 300)
    const settled = settledClaim(300)
    const entries = [bought, settled, sale(100)]
    const proposal = await buildVatSettlementProposal(ledger({ fiscalPeriods: years, entries, shaped: [], filings: [FILED_Q3] }), CO, 'quarterly', 2026, 3)
    expect(proposal.filed_net).toBe(-200)
    // Expected entry: 2611 D 100 / 2650 C 100.
    expect(proposal.lines).toEqual([
      { account_number: '2611', debit_amount: 100, credit_amount: 0 },
      { account_number: '2650', debit_amount: 0, credit_amount: 100, line_description: 'Moms att betala' },
    ])
    // The refund of the 300 filed matches 1650; the correction's 100 is debited on 2650.
    expect(netAccountsAfter([...settled.lines, ...skv(300, '1650'), ...skv(-100, '2650')], proposal.lines)).toEqual({ '2650': 0, '1650': 0 })
  })

  it('books more to get back on 2650 once the period is filed, beside the claim its refund clears', async () => {
    const bought = purchase('2026-07-20', 100)
    const settled = settledClaim(100)
    const entries = [bought, settled, purchase('2026-09-25', 30)]
    const unfiled = await buildVatSettlementProposal(ledger({ fiscalPeriods: years, entries, shaped: [] }), CO, 'quarterly', 2026, 3)
    const filed = await buildVatSettlementProposal(ledger({ fiscalPeriods: years, entries, shaped: [], filings: [FILED_Q3] }), CO, 'quarterly', 2026, 3)
    expect(filed.filed_net).toBe(-130)
    // Before filing, expected entry 2641 C 30 / 1650 D 30: one refund of 130 clears 1650.
    expect(unfiled.lines).toEqual([
      { account_number: '2641', debit_amount: 0, credit_amount: 30 },
      { account_number: '1650', debit_amount: 30, credit_amount: 0, line_description: 'Moms att återfå' },
    ])
    expect(netAccountsAfter([...settled.lines, ...skv(130, '1650')], unfiled.lines)).toEqual({ '2650': 0, '1650': 0 })
    // Filed, expected entry 2641 C 30 / 2650 D 30: the refund of the 100 filed
    // matches 1650, the correction's 30 is booked on 2650.
    expect(filed.lines).toEqual([
      { account_number: '2641', debit_amount: 0, credit_amount: 30 },
      { account_number: '2650', debit_amount: 30, credit_amount: 0, line_description: 'Moms att betala' },
    ])
    expect(netAccountsAfter([...settled.lines, ...skv(100, '1650'), ...skv(30, '2650')], filed.lines)).toEqual({ '2650': 0, '1650': 0 })
  })

  it('keeps the sign rule for a period settled straight against the skattekonto until it is filed', async () => {
    const bought = purchase('2026-07-20', 100)
    const straight = entry('2026-09-30', [{ account_number: '2641', credit: 100 }, { account_number: '1630', debit: 100 }], {
      description: 'Momsredovisning Kvartal 3 2026',
      source_type: 'vat_settlement',
    })
    const entries = [bought, straight, purchase('2026-09-25', 30)]
    const unfiled = await buildVatSettlementProposal(ledger({ fiscalPeriods: years, entries, shaped: [] }), CO, 'quarterly', 2026, 3)
    const filed = await buildVatSettlementProposal(ledger({ fiscalPeriods: years, entries, shaped: [], filings: [FILED_Q3] }), CO, 'quarterly', 2026, 3)
    // Before filing, by sign as on main: 2641 C 30 / 1650 D 30.
    expect(unfiled.lines).toEqual([
      { account_number: '2641', debit_amount: 0, credit_amount: 30 },
      { account_number: '1650', debit_amount: 30, credit_amount: 0, line_description: 'Moms att återfå' },
    ])
    // Filed, the correction's 30 goes where Skatteverket's refund of it is booked: 2641 C 30 / 2650 D 30.
    expect(filed.lines).toEqual([
      { account_number: '2641', debit_amount: 0, credit_amount: 30 },
      { account_number: '2650', debit_amount: 30, credit_amount: 0, line_description: 'Moms att betala' },
    ])
    expect(partlySettledRestBooksAlone(filed)).toBe(true)
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
    // Expected entry (crm#2095): 2641 C 250 / 2650 D 250. The 250 less to pay
    // goes on 2650, where the settlement put its net (#3646). On 1650 it
    // would sit as a claim beside a 250 debt on 2650 with ruta 49 at 0, and
    // neither would ever clear.
    expect(proposal.lines).toEqual([
      { account_number: '2641', debit_amount: 0, credit_amount: 250 },
      { account_number: '2650', debit_amount: 250, credit_amount: 0, line_description: 'Moms att betala' },
    ])
    expect(netAccountsAfter(settled.lines, proposal.lines)).toEqual({ '2650': 0, '1650': 0 })
    expect(vatSettlementBookingStatus(proposal.existing_entries)).toBe('booked')
    // The page offers booking them alone, dated the period's last day: with
    // their 2650 line they have the momsredovisning shape the rutor skip.
    expect(proposal.entry_date).toBe('2026-09-30')
    expect(partlySettledRestBooksAlone(proposal)).toBe(true)
    expect(momsredovisningShapeOfLines(proposal.lines.map((l) => l.account_number), ['1630'])).toBe('net_account_shape')
    // Past a lock date they cannot be dated inside the period: only reversing is offered.
    expect(partlySettledRestBooksAlone({ ...proposal, entry_date_reason: 'company_lock_date' })).toBe(false)
  })

  it('proposes the same lines once Skatteverket has charged the 250, and 2650 holds what it pays back (crm#2095)', async () => {
    // The skattekonto booking's moms rule books the charge on 2650.
    const charged = entry('2026-11-12', [{ account_number: '2650', debit: 250 }, { account_number: '1630', credit: 250 }], { description: 'Moms juli-sept 2026' })
    const entries = [sale, settled, charged, invoice]
    const proposal = await buildVatSettlementProposal(ledger({ fiscalPeriods: years, entries, shaped: [] }), CO, 'quarterly', 2026, 3)
    // Expected entry, as before the charge: 2641 C 250 / 2650 D 250.
    expect(proposal.lines).toEqual([
      { account_number: '2641', debit_amount: 0, credit_amount: 250 },
      { account_number: '2650', debit_amount: 250, credit_amount: 0, line_description: 'Moms att betala' },
    ])
    // 2650 then holds the 250 the corrected declaration gets back, 1650
    // nothing, and the refund Skatteverket books on 2650 clears it.
    expect(netAccountsAfter([...settled.lines, ...charged.lines], proposal.lines)).toEqual({ '2650': -250, '1650': 0 })
    const refunded = [{ account_number: '1630', debit: 250 }, { account_number: '2650', credit: 250 }]
    expect(netAccountsAfter([...settled.lines, ...charged.lines, ...refunded], proposal.lines)).toEqual({ '2650': 0, '1650': 0 })
    // Booked alone, the period reads settled and ruta 49 is still 0.
    const rest = restEntry(proposal.lines)
    const after = await buildVatSettlementProposal(ledger({ fiscalPeriods: years, entries: [...entries, rest], shaped: [rest] }), CO, 'quarterly', 2026, 3)
    expect(after.partly_settled).toBe(false)
    expect(after.filed_net).toBe(0)
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

  it('offers only reversing when the rest is only on a company-mapped 26xx account', () => {
    // A company's own 26xx account routed to a ruta (vat_box, e.g. a Fortnox
    // chart's 2617) is cleared by the momsredovisning, but it is not one of
    // the fixed declaration accounts the shape reads. 2617 and 2650 alone are
    // no momsredovisning shape, so posted they would count as business.
    const lines = [
      { account_number: '2617', debit_amount: 250, credit_amount: 0 },
      { account_number: '2650', debit_amount: 0, credit_amount: 250 },
    ]
    expect(momsredovisningShapeOfLines(lines.map((l) => l.account_number), ['1630'])).toBeNull()
    expect(partlySettledRestBooksAlone({ lines, entry_date_reason: null })).toBe(false)
    // With a line on a fixed declaration account as well, it has the shape.
    const withFixed = [
      { account_number: '2611', debit_amount: 100, credit_amount: 0 },
      { account_number: '2617', debit_amount: 250, credit_amount: 0 },
      { account_number: '2650', debit_amount: 0, credit_amount: 350 },
    ]
    expect(momsredovisningShapeOfLines(withFixed.map((l) => l.account_number), ['1630'])).toBe('net_account_shape')
    expect(partlySettledRestBooksAlone({ lines: withFixed, entry_date_reason: null })).toBe(true)
  })

  it('leaves nothing on 2650 or 1650 that the drift check would flag once the lines are booked (#3646)', async () => {
    const supabase = ledger({ fiscalPeriods: years, entries: [sale, settled, invoice], shaped: [] })
    const proposal = await buildVatSettlementProposal(supabase, CO, 'quarterly', 2026, 3)
    const rows = [...driftRows(settled.id, settled.lines), ...driftRows('rest', asLines(proposal.lines))]
    // Nine months on, long past the deadline Skatteverket nets the period by.
    const drift = settlementAccountDrift(rows, '2027-06-30', null)
    expect([drift.payable.balance, drift.payable.drift]).toEqual([0, 0])
    expect([drift.receivable.balance, drift.receivable.drift]).toEqual([0, 0])
  })

  it('puts a purchase larger than the settled sale on 2650 too, paid or not (#3646)', async () => {
    // 400 of input VAT after a settlement of 250 to pay: ruta 49 is -150.
    const bigger = entry('2026-09-20', [{ account_number: '5010', debit: 1_600 }, { account_number: '2641', debit: 400 }, { account_number: '2440', credit: 2_000 }])
    const proposal = await buildVatSettlementProposal(ledger({ fiscalPeriods: years, entries: [sale, settled, bigger], shaped: [] }), CO, 'quarterly', 2026, 3)
    expect(proposal.filed_net).toBe(-150)
    // Expected entry: 2641 C 400 / 2650 D 400. 2650 then holds the 150 ruta
    // 49 gets back, the net one momsredovisning for the quarter would book.
    expect(proposal.lines).toEqual([
      { account_number: '2641', debit_amount: 0, credit_amount: 400 },
      { account_number: '2650', debit_amount: 400, credit_amount: 0, line_description: 'Moms att betala' },
    ])
    expect(netAccountsAfter(settled.lines, proposal.lines)).toEqual({ '2650': -150, '1650': 0 })
    const once = await buildVatSettlementProposal(ledger({ fiscalPeriods: years, entries: [sale, bigger], shaped: [] }), CO, 'quarterly', 2026, 3)
    expect(positionOf(netAccountsAfter(settled.lines, proposal.lines))).toBe(positionOf(netAccountsAfter([], once.lines)))
    // Once Skatteverket has charged the 250 (booked on 2650), the lines are
    // the same and 2650 holds the 400 it pays back, on one account. Taking
    // the 250 back with 150 on 1650 would leave the refund split in two.
    const charged = entry('2026-11-12', [{ account_number: '2650', debit: 250 }, { account_number: '1630', credit: 250 }], { description: 'Moms juli-sept 2026' })
    const paid = await buildVatSettlementProposal(ledger({ fiscalPeriods: years, entries: [sale, settled, charged, bigger], shaped: [] }), CO, 'quarterly', 2026, 3)
    expect(paid.lines).toEqual(proposal.lines)
    expect(netAccountsAfter([...settled.lines, ...charged.lines], paid.lines)).toEqual({ '2650': -400, '1650': 0 })
  })

  it.each([
    { output: 250.4, input: 250, after: { '2650': 0, '1650': 0 } },
    { output: 250.4, input: 400, after: { '2650': -150, '1650': 0 } },
    { output: 250.7, input: 100.2, after: { '2650': 150, '1650': 0 } },
  ])('carries no öre to 2650/1650 that the posted momsredovisning put on 3740 ($output out, then $input in)', async ({ output, input, after }) => {
    const oreSale = entry('2026-07-15', [
      { account_number: '1510', debit: roundOre(output * 5) },
      { account_number: '3001', credit: roundOre(output * 4) },
      { account_number: '2611', credit: output },
    ])
    const purchase = entry('2026-09-20', [
      { account_number: '5010', debit: roundOre(input * 4) },
      { account_number: '2641', debit: input },
      { account_number: '2440', credit: roundOre(input * 5) },
    ])
    // The app's own momsredovisning of the sale: whole kronor on 2650, the öre on 3740.
    const first = await buildVatSettlementProposal(ledger({ fiscalPeriods: years, entries: [oreSale], shaped: [] }), CO, 'quarterly', 2026, 3)
    expect(roundingAfter(asLines(first.lines))).not.toBe(0)
    const oreSettled = entry('2026-09-30', asLines(first.lines), { description: 'Momsredovisning Kvartal 3 2026', source_type: 'vat_settlement' })
    const proposal = await buildVatSettlementProposal(ledger({ fiscalPeriods: years, entries: [oreSale, oreSettled, purchase], shaped: [] }), CO, 'quarterly', 2026, 3)
    expect(proposal.partly_settled).toBe(true)
    const once = await buildVatSettlementProposal(ledger({ fiscalPeriods: years, entries: [oreSale, purchase], shaped: [] }), CO, 'quarterly', 2026, 3)
    // Together 2650 and 1650 hold the net one momsredovisning for the quarter books, all of it on 2650.
    expect(positionOf(netAccountsAfter(oreSettled.lines, proposal.lines))).toBe(positionOf(netAccountsAfter([], once.lines)))
    expect(netAccountsAfter(oreSettled.lines, proposal.lines)).toEqual(after)
    expect(roundingAfter([...oreSettled.lines, ...asLines(proposal.lines)])).toBe(roundingAfter(asLines(once.lines)))
  })

  it('keeps a refund the posted momsredovisning booked on 2650 there, also once Skatteverket paid it out (#3646)', async () => {
    // 250 to get back, settled against 2650's debit, then 100 more input VAT: ruta 49 is -350.
    const purchase = entry('2026-07-15', [{ account_number: '5010', debit: 1_000 }, { account_number: '2641', debit: 250 }, { account_number: '2440', credit: 1_250 }])
    const refundOn2650 = entry('2026-09-30', [{ account_number: '2641', credit: 250 }, { account_number: '2650', debit: 250 }], {
      description: 'Momsredovisning Kvartal 3 2026',
      source_type: 'vat_settlement',
    })
    const more = entry('2026-09-20', [{ account_number: '5010', debit: 400 }, { account_number: '2641', debit: 100 }, { account_number: '2440', credit: 500 }])
    // Skatteverket paid the 250 out, booked on 2650: 1650 held no claim for it to clear.
    const paidOut = entry('2026-11-12', [{ account_number: '1630', debit: 250 }, { account_number: '2650', credit: 250 }], { description: 'Moms juli-sept 2026' })
    const unpaid = await buildVatSettlementProposal(ledger({ fiscalPeriods: years, entries: [purchase, refundOn2650, more], shaped: [] }), CO, 'quarterly', 2026, 3)
    const paidEntries = [purchase, refundOn2650, paidOut, more]
    const paid = await buildVatSettlementProposal(ledger({ fiscalPeriods: years, entries: paidEntries, shaped: [] }), CO, 'quarterly', 2026, 3)
    expect(unpaid.filed_net).toBe(-350)
    // Expected entry, paid out or not: 2641 C 100 / 2650 D 100. Taking the
    // 250 back (2650 C 250 / 1650 D 350) booked, once it was paid out, a 250
    // debt on 2650 beside a 350 claim on 1650.
    const expected = [
      { account_number: '2641', debit_amount: 0, credit_amount: 100 },
      { account_number: '2650', debit_amount: 100, credit_amount: 0, line_description: 'Moms att betala' },
    ]
    expect(unpaid.lines).toEqual(expected)
    expect(paid.lines).toEqual(expected)
    // 2650 holds what Skatteverket still pays back: the 350 of ruta 49, or
    // the 100 the corrected declaration adds once the 250 is paid out.
    expect(netAccountsAfter(refundOn2650.lines, unpaid.lines)).toEqual({ '2650': -350, '1650': 0 })
    expect(netAccountsAfter([...refundOn2650.lines, ...paidOut.lines], paid.lines)).toEqual({ '2650': -100, '1650': 0 })
    // Booked alone, the period reads settled and ruta 49 is still -350.
    expect(partlySettledRestBooksAlone(paid)).toBe(true)
    const rest = restEntry(paid.lines)
    const after = await buildVatSettlementProposal(ledger({ fiscalPeriods: years, entries: [...paidEntries, rest], shaped: [rest] }), CO, 'quarterly', 2026, 3)
    expect(after.partly_settled).toBe(false)
    expect(after.filed_net).toBe(-350)
  })

  it('names every posted momsredovisning: reversing only the first leaves the period booked (#3646)', async () => {
    // The rest was booked alone, then a second purchase came in: two posted.
    const rest = entry('2026-09-30', [{ account_number: '2641', credit: 250 }, { account_number: '2650', debit: 250 }], { description: 'Moms kvar Q3' })
    const second = entry('2026-09-25', [{ account_number: '5010', debit: 400 }, { account_number: '2641', debit: 100 }, { account_number: '2440', credit: 500 }])
    const both = ledger({ fiscalPeriods: years, entries: [sale, settled, invoice, rest, second], shaped: [rest] })
    const before = await buildVatSettlementProposal(both, CO, 'quarterly', 2026, 3)
    expect(before.partly_settled).toBe(true)
    expect(postedVatSettlements(before.existing_entries).map((e) => e.id).sort()).toEqual([settled.id, rest.id].sort())
    // The refusal names both too, the latest first as journal_entry_id.
    const refused = await bookVatSettlement(ctxOf(both), { period_type: 'quarterly', year: 2026, period: 3 }, { dryRun: true })
    if (refused.ok) throw new Error('booking a period with posted momsredovisningar was not refused')
    expect(refused.code).toBe('VAT_SETTLEMENT_ALREADY_BOOKED')
    const details = refused.details as { journal_entry_id: string; posted_settlements: Array<{ journal_entry_id: string; voucher_number: number | null }> }
    expect(details.posted_settlements.map((e) => e.journal_entry_id).sort()).toEqual([settled.id, rest.id].sort())
    expect(details.journal_entry_id).toBe(details.posted_settlements[0].journal_entry_id)
    expect(details.posted_settlements.map((e) => e.voucher_number).sort()).toEqual([settled.voucher_number, rest.voucher_number].sort())
    // Reversing the one the page used to name alone: the other still gates.
    const first = postedVatSettlements(before.existing_entries)[0]
    const original = [settled, rest].find((e) => e.id === first.id)!
    const storno = entry('2026-09-30', original.lines.map((l) => ({ account_number: l.account_number, debit: l.credit, credit: l.debit })), {
      description: 'Storno',
      source_type: 'storno',
      reverses_id: original.id,
    })
    const after = await buildVatSettlementProposal(
      ledger({
        fiscalPeriods: years,
        entries: [sale, invoice, second, ...[settled, rest].map((e) => (e.id === original.id ? { ...e, status: 'reversed' as const } : e)), storno],
        shaped: [rest].filter((e) => e.id !== original.id),
      }),
      CO, 'quarterly', 2026, 3,
    )
    expect(vatSettlementBookingStatus(after.existing_entries)).toBe('booked')
    expect(postedVatSettlements(after.existing_entries).map((e) => e.id)).toEqual([[settled, rest].find((e) => e.id !== original.id)!.id])
  })

  it('is fully booked again once those lines are posted as a verifikat of their own', async () => {
    const rest = entry('2026-09-30', [{ account_number: '2641', credit: 250 }, { account_number: '2650', debit: 250 }], { description: 'Moms kvar Q3' })
    const supabase = ledger({ fiscalPeriods: years, entries: [sale, settled, invoice, rest], shaped: [rest] })
    const proposal = await buildVatSettlementProposal(supabase, CO, 'quarterly', 2026, 3)
    expect(proposal.partly_settled).toBe(false)
    expect(proposal.existing_entries.map((e) => e.id).sort()).toEqual([settled.id, rest.id].sort())
  })

  it('still sees a posted momsredovisning behind more than twenty later drafts', async () => {
    const early = entry('2026-09-01', [{ account_number: '2611', debit: 250 }, { account_number: '2650', credit: 250 }], {
      description: 'Momsredovisning Kvartal 3 2026',
      source_type: 'vat_settlement',
    })
    const drafts = Array.from({ length: 21 }, (_, i) =>
      entry(`2026-09-${String(i + 2).padStart(2, '0')}`, [{ account_number: '2611', debit: 250 }, { account_number: '2650', credit: 250 }], {
        description: 'Momsredovisning Kvartal 3 2026',
        source_type: 'vat_settlement',
        status: 'draft',
      }),
    )
    const proposal = await buildVatSettlementProposal(ledger({ fiscalPeriods: years, entries: [sale, early, ...drafts], shaped: [] }), CO, 'quarterly', 2026, 3)
    expect(vatSettlementBookingStatus(proposal.existing_entries)).toBe('booked')
    expect(postedVatSettlements(proposal.existing_entries).map((e) => e.id)).toEqual([early.id])
    expect(proposal.existing_entries.filter((e) => e.status === 'draft')).toHaveLength(5)
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
