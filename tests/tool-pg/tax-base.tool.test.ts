/**
 * The bolagsskatt and the periodiseringsfond's 25 % cap rest on the result the
 * declaration files, read on a real database through the doors that read it.
 *
 * Everything the bokslut books carries source_type 'year_end': the depreciation
 * and the dispositions, and also the stock count (49xx), pågående arbeten
 * (3xxx), the finance leases and the kontantmetod cut-off (revenue and cost).
 * The tax base used to rebuild the result from the income statement, which
 * leaves year_end out, plus a list of account groups (88xx, 78xx, 7533). A
 * voucher outside the list was in the declared result and not in the base,
 * so the tax was booked on a result the declaration never showed.
 *
 * Judge: the proposal against INK2 on the same ledger, and against arithmetic
 * written down here. No account list in these assertions.
 */
import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildDispositionsProposal } from '@/lib/bokslut/dispositions-proposal-builder'
import { generateINK2Declaration } from '@/lib/reports/ink2/ink2-engine'
import { seedCompany } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'
import { createToolPgClient } from './client'

type Seed = Awaited<ReturnType<typeof seedCompany>>
type Line = [account: string, debit: number, credit: number]

interface EntryOptions {
  sourceType?: string
  status?: 'posted' | 'reversed'
  entryDate?: string
  reversesId?: string
  correctionOfId?: string
}

let client: ReturnType<typeof createToolPgClient>
let voucherNumber = 0

/** A verifikat as it stands in the ledger: the voucher chain is the point, not how it got there. */
async function book(seed: Seed, lines: Line[], options: EntryOptions = {}): Promise<string> {
  const id = randomUUID()
  const connection = await getPool().connect()
  try {
    await connection.query('BEGIN')
    await connection.query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series, entry_date,
          description, source_type, status, reverses_id, correction_of_id)
       VALUES ($1, $2, $3, $4, $5, 'A', $6, 'Tax base test', $7, $8, $9, $10)`,
      [
        id,
        seed.userId,
        seed.companyId,
        seed.fiscalPeriodId,
        (voucherNumber += 1),
        options.entryDate ?? '2026-12-31',
        options.sourceType ?? 'year_end',
        options.status ?? 'posted',
        options.reversesId ?? null,
        options.correctionOfId ?? null,
      ],
    )
    for (const [account, debit, credit] of lines) {
      await connection.query(
        `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount)
         VALUES ($1, $2, $3, $4)`,
        [id, account, debit, credit],
      )
    }
    await connection.query('COMMIT')
    return id
  } catch (error) {
    await connection.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    connection.release()
  }
}

/** An aktiebolag with 100 000 kr of result before the bokslut: sales 300 000, rent 200 000. */
async function companyWithYear(): Promise<Seed> {
  const seed = await seedCompany()
  await getPool().query(
    `INSERT INTO public.company_settings (user_id, company_id, company_name, entity_type)
     VALUES ($1, $2, 'Bolaget AB', 'aktiebolag')
     ON CONFLICT (company_id) DO UPDATE SET company_name = EXCLUDED.company_name`,
    [seed.userId, seed.companyId],
  )
  await book(seed, [['1930', 300_000, 0], ['3001', 0, 300_000]], { sourceType: 'manual', entryDate: '2026-06-01' })
  await book(seed, [['5010', 200_000, 0], ['1930', 0, 200_000]], { sourceType: 'manual', entryDate: '2026-06-02' })
  return seed
}

function taxProposal(proposal: Awaited<ReturnType<typeof buildDispositionsProposal>>) {
  const found = proposal.proposals.find((item) => item.kind === 'bolagsskatt')
  if (!found) throw new Error(`no bolagsskatt among ${proposal.proposals.map((item) => item.kind).join(', ')}`)
  return found as typeof found & { computation: { resultBeforeTax: number; taxableResultClamped: number } }
}

beforeAll(() => {
  client = createToolPgClient()
})

async function readBoth(seed: Seed) {
  const [proposal, declaration] = await Promise.all([
    buildDispositionsProposal(client, seed.companyId, seed.fiscalPeriodId),
    generateINK2Declaration(client, seed.companyId, seed.fiscalPeriodId),
  ])
  return { proposal, declaration }
}

describe('resultat före skatt, the proposal against the declaration', () => {
  it('counts a stock count and a depreciation booked as year_end', async () => {
    const seed = await companyWithYear()
    await book(seed, [['4960', 40_000, 0], ['1460', 0, 40_000]])
    await book(seed, [['7832', 10_000, 0], ['1229', 0, 10_000]])

    const { proposal, declaration } = await readBoth(seed)

    expect(declaration.ink2s['7670']).toBe(50_000)
    // The cap and the tax after it: 25 % of 50 000, then 20,6 % of the rest.
    expect(proposal.proposals.find((item) => item.kind === 'periodiseringsfond_avsattning')?.amount).toBe(12_500)
    const tax = taxProposal(proposal)
    expect(tax.computation.resultBeforeTax).toBe(37_500)
    expect(tax.amount).toBe(Math.round(37_500 * 0.206))
    expect(proposal.netResultBefore).toBe(50_000)
  })

  it('counts revenue booked as year_end: pågående arbeten and a kontantmetod cut-off', async () => {
    const seed = await companyWithYear()
    await book(seed, [['1620', 25_000, 0], ['3010', 0, 25_000]])
    await book(seed, [['1510', 12_500, 0], ['3001', 0, 10_000], ['2611', 0, 2_500]])

    const { proposal, declaration } = await readBoth(seed)

    expect(declaration.ink2s['7670']).toBe(135_000)
    expect(proposal.proposals.find((item) => item.kind === 'periodiseringsfond_avsattning')?.amount).toBe(33_750)
    expect(proposal.netResultBefore).toBe(135_000)
  })

  it('leaves out the tax, whichever voucher booked it, and counts a booked disposition', async () => {
    const seed = await companyWithYear()
    await book(seed, [['8920', 5_000, 0], ['2510', 0, 5_000]], { sourceType: 'manual', entryDate: '2026-11-30' })
    await book(seed, [['8940', 1_000, 0], ['2240', 0, 1_000]])
    await book(seed, [['8811', 20_000, 0], ['2126', 0, 20_000]])

    const proposal = await buildDispositionsProposal(client, seed.companyId, seed.fiscalPeriodId)

    // Resultat före dispositioner stays 100 000; the avsättning is in the base.
    expect(proposal.netResultBefore).toBe(100_000)
    expect(taxProposal(proposal).computation.resultBeforeTax).toBe(80_000)
  })

  it('follows a corrected voucher through its replacement, whatever accounts it books', async () => {
    const seed = await companyWithYear()
    const original = await book(seed, [['7832', 10_000, 0], ['1229', 0, 10_000]], { status: 'reversed' })
    await book(seed, [['1229', 10_000, 0], ['7832', 0, 10_000]], { sourceType: 'storno', reversesId: original })
    await book(seed, [['6991', 7_000, 0], ['1229', 0, 7_000]], { sourceType: 'correction', correctionOfId: original })

    const { proposal, declaration } = await readBoth(seed)

    expect(declaration.ink2s['7670']).toBe(93_000)
    expect(proposal.netResultBefore).toBe(93_000)
  })

  it('leaves out a resultatavslut booked by hand', async () => {
    const seed = await companyWithYear()
    await book(seed, [['4960', 40_000, 0], ['1460', 0, 40_000]])
    await book(seed, [['3001', 300_000, 0], ['5010', 0, 200_000], ['4960', 0, 40_000], ['2099', 0, 60_000]], { sourceType: 'manual' })

    const { proposal, declaration } = await readBoth(seed)

    expect(declaration.ink2s['7670']).toBe(60_000)
    expect(proposal.netResultBefore).toBe(60_000)
  })

  it('says the booked tax no longer holds when a cut-off is booked after it', async () => {
    const seed = await companyWithYear()
    await book(seed, [['8910', 20_600, 0], ['2512', 0, 20_600]])
    await book(seed, [['1510', 12_500, 0], ['3001', 0, 10_000], ['2611', 0, 2_500]])

    const proposal = await buildDispositionsProposal(client, seed.companyId, seed.fiscalPeriodId)

    expect(proposal.completedDispositions).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'bolagsskatt', status: 'needs_correction' })]),
    )
  })

  // loadTaxAdjustmentSnapshot still reads the year without year_end vouchers:
  // moving it moves INK2S 7653 on a declaration, so that is an operator's call.
  // Goes red the day that path moves: drop `.fails` then.
  it.fails('adds back a non-deductible cost carried on a year_end voucher', async () => {
    const seed = await companyWithYear()
    await book(seed, [['6992', 10_000, 0], ['2440', 0, 10_000]])

    const proposal = await buildDispositionsProposal(client, seed.companyId, seed.fiscalPeriodId)

    expect(proposal.taxAdjustments?.nonDeductibleExpenses).toBe(10_000)
  })

  it('reads a company with an empty year as zero', async () => {
    const empty = await seedCompany()
    const proposal = await buildDispositionsProposal(client, empty.companyId, empty.fiscalPeriodId)
    expect(proposal.netResultBefore).toBe(0)
  })
})
