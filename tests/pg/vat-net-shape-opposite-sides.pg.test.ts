/**
 * Shape 1 of vat_declaration_special_entries takes a verifikat for a
 * momsredovisning only when a declaration-account line stands AGAINST a
 * 2650/1650 line, one in debit and the other in credit (migration
 * 20261127093512).
 *
 * The reported case, with illustrative amounts: an ordinary domestic sale
 * (3001 and 2611 in credit against the bank) with VAT of another scheme
 * booked straight to 2650 next to it, also in credit. The accounts alone made
 * it a momsredovisning: the rutor left the whole verifikat out and the period
 * counted as settled by it. A momsredovisning moves balances between the
 * declaration accounts and 2650/1650, so when all their lines stand on one
 * side nothing moved between them and the rutor read the verifikat.
 *
 * No amounts are compared (every arithmetic narrowing broke real
 * momsredovisningar), so everything with a line against 2650/1650 keeps the
 * shape: the settle-and-pay voucher, the year-end voucher with a sales line,
 * the historical corrections the shape tests pin, and a sale mixed with a
 * refund whose VAT stands against the 2650 line (that one keeps the
 * per-verifikat mark, vat_momsredovisning_marks).
 *
 * The account lists are the REAL ones the app passes, and the same cases pin
 * the TypeScript restatement in src/lib/vat/__tests__/voucher-vat-impact.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { insertPostedJournalEntry, seedCompany } from './fixtures'
import { getPool } from './setup'
import { nextSeq, stornoEntry, type CashCompany } from './kontantmetod-carry-fixtures'
import { VAT_ACCOUNTS, VAT_SETTLEMENT_NET_ACCOUNTS } from '@/lib/reports/vat-declaration'

const ALL_ACCOUNTS = [...VAT_ACCOUNTS, ...VAT_SETTLEMENT_NET_ACCOUNTS]
const START = '2026-01-01'
const END = '2026-03-31'

type Line = [account: string, debit: number, credit: number]

const SALE_WITH_2650_LINE: Line[] = [['1930', 1350, 0], ['3001', 0, 1000], ['2611', 0, 250], ['2650', 0, 100]]
const flipped = (lines: Line[]): Line[] => lines.map(([account, debit, credit]): Line => [account, credit, debit])

/** Every declaration-account line and every 2650/1650 line on one side: read by the rutor. */
const SAME_SIDE: Array<[string, Line[]]> = [
  ['a sale with a 2650 line next to it, all in credit', SALE_WITH_2650_LINE],
  ['the same in debit, as its storno books it', flipped(SALE_WITH_2650_LINE)],
  ['a purchase with a 1650 line next to it, all in debit', [['6110', 400, 0], ['2641', 100, 0], ['1650', 50, 0], ['1930', 0, 550]]],
]

/** A declaration-account line against a 2650/1650 line: a momsredovisning, as before. */
const AGAINST: Array<[string, Line[]]> = [
  ['a classic momsredovisning', [['2611', 250, 0], ['2641', 0, 80], ['2650', 0, 170]]],
  ['one with a small cost line', [['2611', 100, 0], ['2650', 0, 90], ['6570', 0, 10]]],
  ['a refund period: output VAT in debit next to 1650, input VAT against it', [['2611', 100, 0], ['2641', 0, 400], ['1650', 300, 0]]],
  ['a settle-and-pay voucher that debits last period\'s 2650', [['2611', 1000, 0], ['2641', 0, 400], ['2650', 0, 600], ['2650', 500, 0], ['1930', 0, 500]]],
  ['a year-end voucher that clears the VAT next to a sales line', [['1510', 1000, 0], ['3001', 0, 1000], ['2611', 250, 0], ['2650', 0, 250]]],
  ['a historical correction with a 2650 leg', [['5420', 1000.4, 0], ['2645', 0, 1000.4], ['2614', 1000.4, 0], ['2650', 0, 1000], ['3740', 0, 0.4]]],
  ['a correction that moves output VAT to 1650 next to a sales correction', [['2611', 300, 0], ['3001', 300, 0], ['3988', 0, 300], ['1650', 0, 300]]],
  ['a sale mixed with a refund whose VAT stands against the 2650 line', [...SALE_WITH_2650_LINE, ['3001', 100, 0], ['2611', 25, 0], ['1930', 0, 125]]],
]

async function seed() {
  const seeded = await seedCompany()
  const company: CashCompany = { ...seeded, nextPeriodId: seeded.fiscalPeriodId }
  const post = (lines: Line[], entryDate = '2026-02-10', sourceType = 'manual') =>
    insertPostedJournalEntry({
      userId: seeded.userId,
      companyId: seeded.companyId,
      fiscalPeriodId: seeded.fiscalPeriodId,
      voucherNumber: nextSeq() % 1_000_000_000,
      entryDate,
      description: 'net shape sides',
      sourceType,
      lines: lines.map(([accountNumber, debitAmount, creditAmount]) => ({ accountNumber, debitAmount, creditAmount })),
    })
  return { company, companyId: seeded.companyId, post }
}

async function figure(companyId: string) {
  const { rows } = await getPool().query(
    'SELECT public.get_vat_declaration_totals($1,$2,$3,$4,$5,$6) AS payload',
    [companyId, START, END, ALL_ACCOUNTS, VAT_ACCOUNTS, VAT_SETTLEMENT_NET_ACCOUNTS],
  )
  const payload = rows[0].payload as {
    totals: Array<{ account_number: string; debit: number; credit: number }>
    settlement_shaped_entries: Array<{ id: string }>
  }
  const totals = new Map(payload.totals.map((t) => [t.account_number, { debit: Number(t.debit), credit: Number(t.credit) }]))
  return {
    balanceOf: (account: string) => totals.get(account) ?? { debit: 0, credit: 0 },
    shaped: new Set(payload.settlement_shaped_entries.map((e) => e.id)),
  }
}

async function drilled(companyId: string, account: string) {
  const { rows } = await getPool().query<{ journal_entry_id: string }>(
    'SELECT journal_entry_id FROM public.get_vat_ruta_source_lines($1,$2,$3,$4,$5,$6)',
    [companyId, START, END, [account], VAT_ACCOUNTS, VAT_SETTLEMENT_NET_ACCOUNTS],
  )
  return new Set(rows.map((r) => r.journal_entry_id))
}

describe('vat_declaration_special_entries: shape 1 needs a declaration line against a 2650/1650 line', () => {
  it('reads a sale with a 2650 line next to it, next to a real momsredovisning that stays out', async () => {
    const { companyId, post } = await seed()
    const sale = await post(SALE_WITH_2650_LINE)
    const settlement = await post([['2611', 250, 0], ['2650', 0, 250]], END)

    const read = await figure(companyId)
    expect(read.shaped.has(sale)).toBe(false)
    expect(read.shaped.has(settlement)).toBe(true)
    // The rutor read the sale and nothing of the momsredovisning.
    expect(read.balanceOf('3001')).toEqual({ debit: 0, credit: 1000 })
    expect(read.balanceOf('2611')).toEqual({ debit: 0, credit: 250 })
    expect(read.balanceOf('2650')).toEqual({ debit: 0, credit: 100 })
    // The drill-down lists what the figure sums.
    for (const account of ['3001', '2611']) {
      const listed = await drilled(companyId, account)
      expect(listed.has(sale)).toBe(true)
      expect(listed.has(settlement)).toBe(false)
    }
  })

  it('leaves one sale of a correction chain: the sale, its storno and the verifikat that replaces it', async () => {
    const { company, companyId, post } = await seed()
    const original = await post(SALE_WITH_2650_LINE)
    const storno = await stornoEntry(company, original, { date: '2026-02-12' })
    const replacement = await post(SALE_WITH_2650_LINE, '2026-02-12')

    const read = await figure(companyId)
    for (const id of [original, storno, replacement]) expect(read.shaped.has(id)).toBe(false)
    // All three are read, so the annulled pair nets out and the replacement is left.
    expect(read.balanceOf('3001')).toEqual({ debit: 1000, credit: 2000 })
    expect(read.balanceOf('2611')).toEqual({ debit: 250, credit: 500 })
  })

  it.each(SAME_SIDE)('reads %s', async (_label, lines) => {
    const { companyId, post } = await seed()
    const id = await post(lines)
    expect((await figure(companyId)).shaped.has(id)).toBe(false)
  })

  it.each(AGAINST)('still takes %s for a momsredovisning', async (_label, lines) => {
    const { company, companyId, post } = await seed()
    const id = await post(lines)
    expect((await figure(companyId)).shaped.has(id)).toBe(true)
    // Its storno changes the side of every line, so it stays one too and the
    // annulled pair never reaches the rutor.
    const storno = await stornoEntry(company, id, { date: '2026-02-12' })
    const after = await figure(companyId)
    expect(after.shaped.has(id)).toBe(true)
    expect(after.shaped.has(storno)).toBe(true)
  })
})
