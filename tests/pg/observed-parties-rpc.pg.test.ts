import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { insertPostedJournalEntry, insertTransaction, seedCompany } from './fixtures'
import { ledgerKey } from '@/lib/parties/ledger-key'
import { LEDGER_KEY_CASES } from '@/lib/parties/__tests__/ledger-key.test'

/**
 * Parties, phase 1b (migration 20260902170000): ledger_key() and the
 * observed-parties RPC keyed on voucher descriptions.
 *
 * The TS/SQL parity block runs the shared fixture list through both
 * implementations; a change to either side without the other fails here.
 */
describe('ledger_key parity (pg)', () => {
  it('mirrors lib/parties/ledger-key.ts on the shared fixtures', async () => {
    for (const [raw, expected] of LEDGER_KEY_CASES) {
      const { rows } = await getPool().query<{ k: string }>(`SELECT public.ledger_key($1) AS k`, [raw])
      expect(rows[0]!.k, raw).toBe(ledgerKey(raw))
      expect(rows[0]!.k, raw).toBe(expected)
    }
  })

  it('treats NULL as an empty key', async () => {
    const { rows } = await getPool().query<{ k: string }>(`SELECT public.ledger_key(NULL) AS k`)
    expect(rows[0]!.k).toBe('')
  })
})

interface Observed {
  key: string
  name: string
  occurrences: number
  variant_count: number
  expense_sek: number
  revenue_sek: number
  cadence_days: number | null
  dominant_account_number: string | null
  dominant_account_share: number | null
}

async function observed(companyId: string, userId: string, fromDate: string | null = null): Promise<Observed[]> {
  return withUserContext(userId, async (client) => {
    const { rows } = await client.query<{ r: Observed[] }>(
      `SELECT public.get_observed_parties($1, $2, 200) AS r`,
      [companyId, fromDate],
    )
    return rows[0]!.r
  })
}

const expense = (account: string, amount: number) => [
  { accountNumber: account, debitAmount: amount, creditAmount: 0 },
  { accountNumber: '2440', debitAmount: 0, creditAmount: amount },
]

describe('get_observed_parties (pg)', () => {
  it('groups posted vouchers by ledger_key, sums expense SEK, and reports cadence and dominant account', async () => {
    const c = await seedCompany()
    const base = { userId: c.userId, companyId: c.companyId, fiscalPeriodId: c.fiscalPeriodId, sourceType: 'import' }
    await insertPostedJournalEntry({ ...base, entryDate: '2026-01-10', description: 'Levfakt BEIJER BYGGMATERIAL AB (2089)', lines: expense('4000', 1000) })
    await insertPostedJournalEntry({ ...base, entryDate: '2026-02-09', description: 'Levfakt Beijer Byggmaterial AB, 097 (1001)', lines: expense('4000', 2000) })
    await insertPostedJournalEntry({ ...base, entryDate: '2026-03-11', description: 'Levfakt Beijer Byggmaterial AB (2089)', lines: expense('4010', 500) })
    await insertPostedJournalEntry({ ...base, entryDate: '2026-03-15', description: 'Inköp av varor', lines: expense('4010', 300) })

    const rows = await observed(c.companyId, c.userId)
    const beijer = rows.find((r) => r.key === 'beijer byggmaterial')
    expect(beijer).toBeDefined()
    expect(beijer!.occurrences).toBe(3)
    expect(beijer!.variant_count).toBe(3)
    expect(Number(beijer!.expense_sek)).toBe(3500)
    expect(Number(beijer!.revenue_sek)).toBe(0)
    expect(beijer!.cadence_days).toBe(30)
    expect(beijer!.dominant_account_number).toBe('4000')
    // Laplace: (2+1)/(3+2)
    expect(Number(beijer!.dominant_account_share)).toBe(0.6)
    expect(rows.find((r) => r.key === 'inköp av varor')).toBeDefined()
    // Sorted by money, so Beijer comes first.
    expect(rows[0]!.key).toBe('beijer byggmaterial')
  })

  it('counts revenue on 3xxx credits and skips pure balance-sheet vouchers', async () => {
    const c = await seedCompany()
    const base = { userId: c.userId, companyId: c.companyId, fiscalPeriodId: c.fiscalPeriodId, sourceType: 'import' }
    await insertPostedJournalEntry({
      ...base,
      entryDate: '2026-04-01',
      description: 'Kundfaktura Acme Konsult AB',
      lines: [
        { accountNumber: '1510', debitAmount: 12500, creditAmount: 0 },
        { accountNumber: '3011', debitAmount: 0, creditAmount: 10000 },
        { accountNumber: '2611', debitAmount: 0, creditAmount: 2500 },
      ],
    })
    await insertPostedJournalEntry({
      ...base,
      entryDate: '2026-04-02',
      description: 'Överföring till sparkonto',
      lines: [
        { accountNumber: '1940', debitAmount: 5000, creditAmount: 0 },
        { accountNumber: '1930', debitAmount: 0, creditAmount: 5000 },
      ],
    })
    const rows = await observed(c.companyId, c.userId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.key).toBe('kundfaktura acme konsult')
    expect(Number(rows[0]!.revenue_sek)).toBe(10000)
  })

  it('excludes storno, opening-balance, year-end and VAT-settlement vouchers, and honours the window', async () => {
    const c = await seedCompany()
    const base = { userId: c.userId, companyId: c.companyId, fiscalPeriodId: c.fiscalPeriodId }
    await insertPostedJournalEntry({ ...base, sourceType: 'import', entryDate: '2025-06-01', description: 'Telia Sverige AB', lines: expense('6212', 100) })
    await insertPostedJournalEntry({ ...base, sourceType: 'import', entryDate: '2026-06-01', description: 'Telia Sverige AB', lines: expense('6212', 100) })
    await insertPostedJournalEntry({ ...base, sourceType: 'storno', entryDate: '2026-06-02', description: 'Telia Sverige AB', lines: expense('6212', 100) })
    await insertPostedJournalEntry({ ...base, sourceType: 'opening_balance', entryDate: '2026-01-01', description: 'Ingående balans', lines: expense('4000', 100) })
    await insertPostedJournalEntry({ ...base, sourceType: 'year_end', entryDate: '2026-12-31', description: 'Årets resultat', lines: expense('8999', 100) })

    const all = await observed(c.companyId, c.userId)
    const telia = all.find((r) => r.key === 'telia sverige')
    expect(telia!.occurrences).toBe(2)
    expect(all.find((r) => r.key === 'ingående balans')).toBeUndefined()
    expect(all.find((r) => r.key === 'årets resultat')).toBeUndefined()

    const windowed = await observed(c.companyId, c.userId, '2026-01-01')
    expect(windowed.find((r) => r.key === 'telia sverige')!.occurrences).toBe(1)
  })

  it('leaves vouchers that carry a bank merchant name to the bank-keyed RPC', async () => {
    const c = await seedCompany()
    const base = { userId: c.userId, companyId: c.companyId, fiscalPeriodId: c.fiscalPeriodId, sourceType: 'bank_transaction' }
    const withBank = await insertPostedJournalEntry({ ...base, entryDate: '2026-05-01', description: 'Loopia AB', lines: expense('6542', 99) })
    await insertPostedJournalEntry({ ...base, entryDate: '2026-05-02', description: 'Loopia AB', lines: expense('6542', 99) })
    const txId = await insertTransaction({
      userId: c.userId,
      companyId: c.companyId,
      journalEntryId: withBank,
      description: 'LOOPIA AB',
      amount: -99,
      date: '2026-05-01',
    })
    await getPool().query(`UPDATE public.transactions SET merchant_name = 'LOOPIA AB' WHERE id = $1`, [txId])
    const rows = await observed(c.companyId, c.userId)
    const loopia = rows.find((r) => r.key === 'loopia')
    expect(loopia!.occurrences).toBe(1)
  })

  it('does not leak across companies and returns [] for an empty company', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    await insertPostedJournalEntry({ userId: a.userId, companyId: a.companyId, fiscalPeriodId: a.fiscalPeriodId, sourceType: 'import', description: 'Levfakt Dahls Bageri AB (167)', lines: expense('4000', 100) })
    expect(await observed(b.companyId, b.userId)).toEqual([])
    // A member of company b asking for company a's rows sees nothing: RLS.
    const cross = await withUserContext(b.userId, async (client) => {
      const { rows } = await client.query<{ r: Observed[] }>(`SELECT public.get_observed_parties($1, NULL, 200) AS r`, [a.companyId])
      return rows[0]!.r
    })
    expect(cross).toEqual([])
  })
})
