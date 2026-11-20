/**
 * An opening balance feeds the momsdeklaration only when it is dated inside
 * the declared period with nothing of the period before it in the books, and
 * a storno or rättelse always follows the IB at its root (crm#1333, migration
 * 20261021000500).
 *
 * The case behind the ticket, anonymised: a SIE opening balance carried 2641,
 * 2645, 2614 and 2650 balances into the year. Correcting the opening balances
 * stornoed it and booked a new one without 26xx. Both VAT functions kept the
 * original IB in the rutor (opening balances were exempt from the shapes) and
 * dropped its storno as a "momsredovisning" (it carries a 2650 line and is no
 * opening balance), so rutor 30 and 48 still held the old balances with
 * nothing taking them out.
 *
 * For a company that keeps books, VAT belongs to the period in which it is
 * booked or should have been booked (ML 2023:200 7 kap. 14 § and 31 §; SFL
 * 26 kap. 5 § 2 st., 10-11 §§). An IB on the period's first day carries only
 * earlier periods: it, its storno and its rättelse (and theirs, down the
 * chain) leave the declaration together. An IB dated inside the period counts
 * only when nothing of the period before it is in the books (a migration
 * mid-period: it is the only carrier of those days); with those verifikat in
 * the books (the year-end roll-forward into a räkenskapsår starting
 * mid-period) it would count them twice and stays out. A counted chain is
 * kept out of the momsredovisning shapes so a pair still nets to zero.
 */
import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool } from './setup'
import {
  insertAuthUser,
  insertCompany,
  insertFiscalPeriod,
  insertPostedJournalEntry,
} from './fixtures'
import { markReversed, nextSeq, postStorno, stornoEntry, type CashCompany } from './kontantmetod-carry-fixtures'

// A representative slice of ACCOUNT_RUTA; the full list is a parameter.
const RUTA_ACCOUNTS = ['2611', '2614', '2641', '2645', '3001']
const NET_ACCOUNTS = ['2650', '1650']
const ALL_ACCOUNTS = [...RUTA_ACCOUNTS, ...NET_ACCOUNTS]
const START = '2026-01-01'
const END = '2026-03-31'

type Line = [account: string, debit: number, credit: number]

interface Payload {
  totals: Array<{ account_number: string; debit: number; credit: number }>
  settlement_shaped_entries: Array<{ id: string; source_type: string | null }>
  source_type_counts: Record<string, number>
  counted_opening_balances: Array<{ id: string; status: string; entry_date: string }>
}

interface DrillLine {
  journal_entry_id: string
  debit_amount: string | number
  credit_amount: string | number
}

async function figure(companyId: string, start = START, end = END): Promise<Payload> {
  const { rows } = await getPool().query(
    `SELECT public.get_vat_declaration_totals($1,$2,$3,$4,$5,$6) AS payload`,
    [companyId, start, end, ALL_ACCOUNTS, RUTA_ACCOUNTS, NET_ACCOUNTS],
  )
  return rows[0].payload as Payload
}

async function drillDown(companyId: string, accounts: string[], start = START, end = END): Promise<DrillLine[]> {
  const { rows } = await getPool().query(
    `SELECT * FROM public.get_vat_ruta_source_lines($1,$2,$3,$4,$5,$6, NULL, NULL, NULL, NULL, 501)`,
    [companyId, start, end, accounts, RUTA_ACCOUNTS, NET_ACCOUNTS],
  )
  return rows as DrillLine[]
}

function balanceOf(payload: Payload, account: string) {
  const t = payload.totals.find((row) => row.account_number === account)
  return { debit: Number(t?.debit ?? 0), credit: Number(t?.credit ?? 0) }
}

/** The drill-down lists exactly what the figure sums, account by account. */
async function expectDrillDownAgrees(companyId: string, start = START, end = END) {
  const payload = await figure(companyId, start, end)
  const mismatches: string[] = []
  for (const account of ALL_ACCOUNTS) {
    const lines = await drillDown(companyId, [account], start, end)
    const debit = lines.reduce((sum, l) => sum + Number(l.debit_amount ?? 0), 0)
    const credit = lines.reduce((sum, l) => sum + Number(l.credit_amount ?? 0), 0)
    const expected = balanceOf(payload, account)
    if (
      Math.round(debit * 100) !== Math.round(expected.debit * 100) ||
      Math.round(credit * 100) !== Math.round(expected.credit * 100)
    ) {
      mismatches.push(`${account}: drill-down ${debit}/${credit} vs figure ${expected.debit}/${expected.credit}`)
    }
  }
  expect(mismatches).toEqual([])
}

async function seed() {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  const fiscalPeriodId = await insertFiscalPeriod({ userId, companyId })
  const company: CashCompany = { userId, companyId, fiscalPeriodId, nextPeriodId: fiscalPeriodId }
  const post = (lines: Line[], sourceType = 'manual', entryDate = '2026-02-15') =>
    insertPostedJournalEntry({
      userId,
      companyId,
      fiscalPeriodId,
      voucherNumber: nextSeq() % 1_000_000_000,
      entryDate,
      description: 'carried entries test',
      sourceType,
      lines: lines.map(([accountNumber, debitAmount, creditAmount]) => ({ accountNumber, debitAmount, creditAmount })),
    })
  return { company, companyId, post }
}

/**
 * correctEntry's writes on an entry: its storno, then the rättelse
 * (source_type correction, correction_of_id), then the original marked
 * reversed.
 */
async function correctLike(company: CashCompany, entryId: string, lines: Line[], date: string) {
  const stornoId = await postStorno(company, entryId, { date })
  const correctionId = randomUUID()
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
          entry_date, description, source_type, correction_of_id, status)
       SELECT $1, e.user_id, e.company_id, e.fiscal_period_id, $2, 'A', $3,
              'Rättelse: Ingående balans', 'correction', e.id, 'draft'
       FROM public.journal_entries e WHERE e.id = $4`,
      [correctionId, nextSeq() % 1_000_000_000, date, entryId],
    )
    for (const [index, [account, debit, credit]] of lines.entries()) {
      await client.query(
        `INSERT INTO public.journal_entry_lines
           (journal_entry_id, account_number, debit_amount, credit_amount, currency, sort_order)
         VALUES ($1, $2, $3, $4, 'SEK', $5)`,
        [correctionId, account, debit, credit, index],
      )
    }
    await client.query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [correctionId])
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
  await markReversed(entryId, stornoId)
  return { stornoId, correctionId }
}

describe('opening balances in the momsdeklaration (crm#1333)', () => {
  it('leaves an opening balance on the period\'s first day out of the totals and out of the shapes', async () => {
    const { companyId, post } = await seed()
    // Last year's VAT still open on 26xx at the year end, carried in.
    await post(
      [['2641', 500, 0], ['2645', 100, 0], ['2614', 0, 100], ['2650', 0, 300], ['2099', 0, 200]],
      'opening_balance',
      START,
    )
    // This quarter's own purchase.
    await post([['2641', 80, 0], ['6110', 320, 0], ['1930', 0, 400]])

    const payload = await figure(companyId)
    expect(balanceOf(payload, '2641')).toEqual({ debit: 80, credit: 0 })
    expect(balanceOf(payload, '2645')).toEqual({ debit: 0, credit: 0 })
    expect(balanceOf(payload, '2614')).toEqual({ debit: 0, credit: 0 })
    expect(balanceOf(payload, '2650')).toEqual({ debit: 0, credit: 0 })
    expect(payload.settlement_shaped_entries).toEqual([])
    // Still a verifikat of the period: the counts describe the period, not the rutor.
    expect(payload.source_type_counts).toEqual({ opening_balance: 1, manual: 1 })
    await expectDrillDownAgrees(companyId)
  }, 60_000)

  it('leaves the storno of an opening balance on the first day out with it instead of reading it as a momsredovisning', async () => {
    const { company, companyId, post } = await seed()
    // The ticket's shape: 26xx balances and a 2650/1650 line in one IB.
    const openingId = await post(
      [
        ['1650', 396, 0],
        ['2641', 191.08, 0],
        ['2645', 44.96, 0],
        ['2614', 0, 44.96],
        ['2650', 0, 123.09],
        ['2099', 0, 463.99],
      ],
      'opening_balance',
      START,
    )
    // Correcting the opening balances: storno of the IB, a new IB without 26xx.
    const stornoId = await stornoEntry(company, openingId, { date: START })
    await post([['1650', 396, 0], ['2099', 0, 396]], 'opening_balance', START)
    // The quarter's own reverse-charge purchase and an ordinary purchase.
    await post([['2645', 25, 0], ['2614', 0, 25], ['4535', 100, 0], ['2440', 0, 100]])
    await post([['2641', 80, 0], ['6110', 320, 0], ['1930', 0, 400]])

    const payload = await figure(companyId)
    // Only the quarter's own VAT: ruta 30 = 25, ruta 48 = 80 + 25.
    expect(balanceOf(payload, '2614')).toEqual({ debit: 0, credit: 25 })
    expect(balanceOf(payload, '2645')).toEqual({ debit: 25, credit: 0 })
    expect(balanceOf(payload, '2641')).toEqual({ debit: 80, credit: 0 })
    expect(balanceOf(payload, '1650')).toEqual({ debit: 0, credit: 0 })
    expect(payload.settlement_shaped_entries.map((e) => e.id)).not.toContain(stornoId)
    expect(payload.settlement_shaped_entries).toEqual([])
    await expectDrillDownAgrees(companyId)
  }, 60_000)

  it('leaves a rättelse of an opening balance, and the storno of that rättelse, out: the whole chain', async () => {
    const { company, companyId, post } = await seed()
    const openingId = await post([['2641', 200, 0], ['2099', 0, 200]], 'opening_balance', START)
    const { correctionId } = await correctLike(company, openingId, [['2641', 250, 0], ['2099', 0, 250]], START)
    // The rättelse is annulled again: its storno reverses a carried entry.
    const correctionStorno = await postStorno(company, correctionId, { date: START })
    await markReversed(correctionId, correctionStorno)
    await post([['2641', 80, 0], ['6110', 320, 0], ['1930', 0, 400]])

    const payload = await figure(companyId)
    expect(balanceOf(payload, '2641')).toEqual({ debit: 80, credit: 0 })
    expect(payload.settlement_shaped_entries).toEqual([])
    await expectDrillDownAgrees(companyId)
  }, 60_000)

  it('counts an opening balance dated inside the period, outside the shapes even with a 2650 line', async () => {
    const { companyId, post } = await seed()
    // A migration on 1 February: the IB carries January's VAT, whose
    // verifikat are not in the books, plus last year's 2650 debt.
    const openingId = await post(
      [['2641', 40, 0], ['2611', 0, 500], ['2650', 0, 300], ['1930', 760, 0]],
      'opening_balance',
      '2026-02-01',
    )
    await post([['2641', 80, 0], ['6110', 320, 0], ['1930', 0, 400]], 'manual', '2026-03-10')

    // The quarter holds January through the IB and March through its verifikat.
    const quarter = await figure(companyId)
    expect(balanceOf(quarter, '2611')).toEqual({ debit: 0, credit: 500 })
    expect(balanceOf(quarter, '2641')).toEqual({ debit: 120, credit: 0 })
    expect(quarter.settlement_shaped_entries).toEqual([])
    expect(quarter.counted_opening_balances.map((e) => e.id)).toEqual([openingId])
    expect((await drillDown(companyId, ['2611'])).map((l) => l.journal_entry_id)).toEqual([openingId])
    await expectDrillDownAgrees(companyId)

    // February's own declaration starts on the IB's date: there it carries
    // only January, an earlier period, and stays out.
    const february = await figure(companyId, '2026-02-01', '2026-02-28')
    expect(balanceOf(february, '2611')).toEqual({ debit: 0, credit: 0 })
    expect(balanceOf(february, '2641')).toEqual({ debit: 0, credit: 0 })
    expect(february.counted_opening_balances).toEqual([])
    await expectDrillDownAgrees(companyId, '2026-02-01', '2026-02-28')
  }, 60_000)

  it('nets an opening balance dated inside the period and its storno to zero, neither read as a momsredovisning', async () => {
    const { company, companyId, post } = await seed()
    const openingId = await post(
      [['2641', 40, 0], ['2611', 0, 500], ['2650', 0, 300], ['1930', 760, 0]],
      'opening_balance',
      '2026-02-01',
    )
    const stornoId = await stornoEntry(company, openingId, { date: '2026-02-01' })
    await post([['2641', 80, 0], ['6110', 320, 0], ['1930', 0, 400]], 'manual', '2026-03-10')

    const payload = await figure(companyId)
    expect(balanceOf(payload, '2611')).toEqual({ debit: 500, credit: 500 })
    expect(balanceOf(payload, '2641')).toEqual({ debit: 120, credit: 40 })
    expect(payload.settlement_shaped_entries.map((e) => e.id)).not.toContain(stornoId)
    expect(payload.settlement_shaped_entries).toEqual([])
    await expectDrillDownAgrees(companyId)
  }, 60_000)

  it('leaves an IB inside the period out when the period\'s earlier verifikat are in the books: no double count', async () => {
    // A räkenskapsår starting 1 May: the year-end roll-forward dates the IB on
    // 1 May, inside Q2, and April's own verifikat are in the same books.
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    const before = await insertFiscalPeriod({ userId, companyId, name: '2025/26', periodStart: '2025-05-01', periodEnd: '2026-04-30' })
    const after = await insertFiscalPeriod({ userId, companyId, name: '2026/27', periodStart: '2026-05-01', periodEnd: '2027-04-30' })
    const company: CashCompany = { userId, companyId, fiscalPeriodId: after, nextPeriodId: after }
    const post = (fiscalPeriodId: string, entryDate: string, lines: Line[], sourceType = 'manual') =>
      insertPostedJournalEntry({
        userId, companyId, fiscalPeriodId, entryDate, sourceType,
        voucherNumber: nextSeq() % 1_000_000_000,
        description: 'broken year test',
        lines: lines.map(([accountNumber, debitAmount, creditAmount]) => ({ accountNumber, debitAmount, creditAmount })),
      })
    await post(before, '2026-04-15', [['1930', 1250, 0], ['3001', 0, 1000], ['2611', 0, 250]])
    // April's 2611 rolled forward, uncleared at the year end.
    const openingId = await post(after, '2026-05-01', [['1930', 0, 250], ['2611', 0, 250], ['2099', 500, 0]], 'opening_balance')
    await post(after, '2026-06-10', [['1930', 625, 0], ['3001', 0, 500], ['2611', 0, 125]])

    const q2 = await figure(companyId, '2026-04-01', '2026-06-30')
    expect(balanceOf(q2, '2611')).toEqual({ debit: 0, credit: 375 })
    expect(q2.settlement_shaped_entries).toEqual([])
    expect(q2.counted_opening_balances).toEqual([])
    await expectDrillDownAgrees(companyId, '2026-04-01', '2026-06-30')

    // Annulled and booked again: the storno follows its IB out as well.
    await stornoEntry(company, openingId, { date: '2026-05-01', fiscalPeriodId: after })
    const again = await figure(companyId, '2026-04-01', '2026-06-30')
    expect(balanceOf(again, '2611')).toEqual({ debit: 0, credit: 375 })
    expect(again.settlement_shaped_entries).toEqual([])
    await expectDrillDownAgrees(companyId, '2026-04-01', '2026-06-30')
  }, 60_000)

  it('reads an entry marked opening_balance that books a resultatkonto as an ordinary verifikat', async () => {
    const { companyId, post } = await seed()
    // A purchase marked as an opening balance in bank reconciliation: no IB
    // door writes class 3-8, so it is a business event of the period.
    const markedId = await post(
      [['6540', 100, 0], ['2645', 25, 0], ['2614', 0, 25], ['1930', 0, 100]],
      'opening_balance',
      START,
    )

    const payload = await figure(companyId)
    expect(balanceOf(payload, '2645')).toEqual({ debit: 25, credit: 0 })
    expect(balanceOf(payload, '2614')).toEqual({ debit: 0, credit: 25 })
    expect(payload.counted_opening_balances).toEqual([])
    expect((await drillDown(companyId, ['2645'])).map((l) => l.journal_entry_id)).toEqual([markedId])
    await expectDrillDownAgrees(companyId)
  }, 60_000)

  it('nets an ordinary storno pair to zero: both halves counted', async () => {
    const { company, companyId, post } = await seed()
    const purchaseId = await post([['2641', 80, 0], ['6110', 320, 0], ['1930', 0, 400]])
    await stornoEntry(company, purchaseId, { date: '2026-02-20' })

    const payload = await figure(companyId)
    expect(balanceOf(payload, '2641')).toEqual({ debit: 80, credit: 80 })
    expect(payload.settlement_shaped_entries).toEqual([])
    await expectDrillDownAgrees(companyId)
  }, 60_000)

  it('still excludes a real momsredovisning by its 2650 shape', async () => {
    const { companyId, post } = await seed()
    await post([['1930', 1250, 0], ['3001', 0, 1000], ['2611', 0, 250]])
    await post([['2641', 80, 0], ['6110', 320, 0], ['1930', 0, 400]])
    const settlementId = await post([['2611', 250, 0], ['2641', 0, 80], ['2650', 0, 170]], 'manual', END)

    const payload = await figure(companyId)
    expect(balanceOf(payload, '2611')).toEqual({ debit: 0, credit: 250 })
    expect(balanceOf(payload, '2641')).toEqual({ debit: 80, credit: 0 })
    expect(balanceOf(payload, '2650')).toEqual({ debit: 0, credit: 0 })
    expect(payload.settlement_shaped_entries.map((e) => e.id)).toEqual([settlementId])
    await expectDrillDownAgrees(companyId)
  }, 60_000)
})
