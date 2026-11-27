/**
 * The staged create_voucher preview decides whether the momsdeklaration would
 * read a voucher before it is posted (crm#1447), through a TypeScript
 * restatement of the momsredovisning shapes (momsredovisningShapeOfLines in
 * src/lib/vat/voucher-vat-impact.ts). This pins it to the SQL that decides
 * once the voucher is posted: every case below is posted as a manual verifikat
 * and get_vat_declaration_totals must list exactly the ones the restatement
 * calls a shape, with the skattekonto accounts read from
 * skattekonto_shape_accounts as the preview reads them. Shape 1 reads the
 * side each line stands on, so the restatement is given the lines, not only
 * their accounts.
 *
 * The account lists are the REAL ones the app passes (VAT_ACCOUNTS and
 * VAT_SETTLEMENT_NET_ACCOUNTS), as in vat-skattekonto-counter-entries.pg.test.ts.
 */
import { describe, it, expect } from 'vitest'
import { getPool } from './setup'
import {
  insertAuthUser,
  insertCompany,
  insertFiscalPeriod,
  insertPostedJournalEntry,
} from './fixtures'
import { VAT_ACCOUNTS, VAT_SETTLEMENT_NET_ACCOUNTS } from '@/lib/reports/vat-declaration'
import { momsredovisningShapeOfLines, type VoucherImpactLine } from '@/lib/vat/voucher-vat-impact'

const ALL_ACCOUNTS = [...VAT_ACCOUNTS, ...VAT_SETTLEMENT_NET_ACCOUNTS]
const START = '2026-01-01'
const END = '2026-12-31'

type Line = [account: string, debit: number, credit: number]

// Shapes, near misses and ordinary verifikat, the crm#1447 correction first.
const CASES: Line[][] = [
  [['5420', 1000.4, 0], ['2645', 0, 1000.4], ['2614', 1000.4, 0], ['2650', 0, 1000], ['3740', 0, 0.4]],
  [['5420', 1000, 0], ['2645', 0, 1000]],
  [['2611', 250, 0], ['2641', 0, 80], ['2650', 0, 170]],
  [['2611', 100, 0], ['2650', 0, 90], ['6570', 0, 10]],
  [['2641', 0, 80], ['1650', 80, 0]],
  [['1630', 300, 0], ['2610', 0, 300]],
  [['2611', 249.6, 0], ['2641', 0, 99.2], ['3740', 0, 0.4], ['1630', 0, 150]],
  [['1630', 25136, 0], ['3980', 0, 25136]],
  [['5410', 400, 0], ['2641', 100, 0], ['1630', 0, 500]],
  [['2650', 150, 0], ['1630', 0, 150]],
  [['1930', 1250, 0], ['3001', 0, 1000], ['2611', 0, 250]],
  [['2645', 25, 0], ['2614', 0, 25], ['4535', 100, 0], ['2440', 0, 100]],
  [['2611', 300, 0], ['2012', 0, 300]],
  // The rest of a partly settled period (#3646) puts its net on 2650 or 1650
  // either way round. The restatement calls each a net_account_shape
  // (vat-settlement-match.test.ts), so here the SQL must skip them too,
  // whichever side the 2650/1650 line is on.
  [['2641', 0, 250], ['2650', 250, 0]],
  [['2611', 400.4, 0], ['2614', 500.5, 0], ['2645', 0, 500.5], ['1650', 0, 400], ['3740', 0, 0.4]],
  [['2611', 400.4, 0], ['1650', 0, 70], ['2650', 0, 330], ['3740', 0, 0.4]],
  // A sale or a purchase with a same-side 2650/1650 line: no shape. A sale
  // with a 2650 line next to it, its storno, a sale with its VAT on 2650, a
  // grant next to a refund on the skattekonto.
  [['1930', 1350, 0], ['3001', 0, 1000], ['2611', 0, 250], ['2650', 0, 100]],
  [['1930', 0, 1350], ['3001', 1000, 0], ['2611', 250, 0], ['2650', 100, 0]],
  [['1510', 1250, 0], ['3001', 0, 1000], ['2650', 0, 250]],
  [['1630', 30000, 0], ['3980', 0, 24000], ['1650', 0, 6000]],
  // Only 26xx next to a same-side 2650/1650 line, or a zero base line: the
  // shape stays.
  [['2641', 0, 488], ['2650', 0, 891], ['6992', 1379, 0]],
  [['6110', 400, 0], ['2641', 100, 0], ['1650', 50, 0], ['1930', 0, 550]],
  [['1930', 250, 0], ['3001', 0, 0], ['2611', 0, 150], ['2650', 0, 100]],
  // A line against 2650/1650 among others: still the shape.
  [['2611', 1000, 0], ['2641', 0, 400], ['2650', 0, 600], ['2650', 500, 0], ['1930', 0, 500]],
  [['1510', 1000, 0], ['3001', 0, 1000], ['2611', 250, 0], ['2650', 0, 250]],
  [['1930', 1225, 0], ['3001', 0, 1000], ['2611', 0, 250], ['2650', 0, 100], ['3001', 100, 0], ['2611', 25, 0]],
]

const toImpactLines = (lines: Line[]): VoucherImpactLine[] =>
  lines.map(([account_number, debit_amount, credit_amount]) => ({ account_number, debit_amount, credit_amount }))

async function shapedIds(companyId: string): Promise<Set<string>> {
  const { rows } = await getPool().query(
    `SELECT public.get_vat_declaration_totals($1,$2,$3,$4,$5,$6) AS payload`,
    [companyId, START, END, ALL_ACCOUNTS, VAT_ACCOUNTS, VAT_SETTLEMENT_NET_ACCOUNTS],
  )
  const payload = rows[0].payload as { settlement_shaped_entries: Array<{ id: string }> }
  return new Set(payload.settlement_shaped_entries.map((e) => e.id))
}

async function disagreements(entityType: 'aktiebolag' | 'enskild_firma'): Promise<string[]> {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId, entityType })
  const fiscalPeriodId = await insertFiscalPeriod({ userId, companyId })
  const ids: string[] = []
  for (const [index, lines] of CASES.entries()) {
    ids.push(await insertPostedJournalEntry({
      userId,
      companyId,
      fiscalPeriodId,
      voucherNumber: index + 1,
      entryDate: '2026-03-15',
      description: 'voucher impact shape parity',
      sourceType: 'manual',
      lines: lines.map(([accountNumber, debitAmount, creditAmount]) => ({ accountNumber, debitAmount, creditAmount })),
    }))
  }

  const { rows } = await getPool().query(
    'SELECT public.skattekonto_shape_accounts($1) AS accounts',
    [companyId],
  )
  const taxAccounts = rows[0].accounts as string[]
  const shaped = await shapedIds(companyId)

  return CASES.flatMap((lines, index) => {
    const sql = shaped.has(ids[index])
    const ts = momsredovisningShapeOfLines(toImpactLines(lines), taxAccounts) !== null
    return sql === ts ? [] : [`${entityType} ${lines.map(([a]) => a).join('/')}: sql ${sql}, preview ${ts}`]
  })
}

describe('momsredovisningShapeOfLines agrees with get_vat_declaration_totals', () => {
  it('for an aktiebolag', async () => {
    expect(await disagreements('aktiebolag')).toEqual([])
  }, 60_000)

  it('for an enskild firma, where 2012 is the skattekonto too', async () => {
    expect(await disagreements('enskild_firma')).toEqual([])
  }, 60_000)
})
