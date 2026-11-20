/**
 * Resultat per dimension, read through a REAL PostgREST.
 *
 * The report put every figure in the "(Utan dimension)" column although the
 * posted lines carried the dimension, while the general ledger and the
 * journal query showed the tags on the same lines.
 *
 * The cause is not visible to a faked client, which is why it shipped. The
 * tagged pass asked PostgREST for `dimensions->>6 IS NOT NULL`. A SIE
 * dimension number is all digits, and PostgREST reads a digits-only JSON path
 * operand as an ARRAY INDEX: the SQL it runs is `dimensions ->> 6` with an
 * integer, which is NULL on every object, so the filter matched no line. The
 * unit suite's fake answered the same string as a key lookup, the reading the
 * author had in mind, and stayed green.
 *
 * So the assertions here are about agreement between the readers, on a real
 * database: the columns of the per-dimension result must equal what the
 * dimension-filtered resultatrapport, the general ledger and the trial
 * balance say for the same value.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { tools } from '@/extensions/general/mcp-server/server'
import { generateDimensionPnl } from '@/lib/reports/dimension-pnl'
import { generateGeneralLedger } from '@/lib/reports/general-ledger'
import { resultatrapportRows, signedAmount } from '@/lib/reports/resultatrapport'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { insertPostedJournalEntry, seedCompany } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'
import type { DimensionPnlReport } from '@/types'
import { createToolPgClient } from './client'

let client: ReturnType<typeof createToolPgClient>
let companyId: string
let userId: string
let fiscalPeriodId: string

/** values[] of one account row, keyed by column code ('' = untagged). */
function byColumn(report: DimensionPnlReport, accountNumber: string): Record<string, number> {
  const row = report.groups.flatMap((g) => g.rows).find((r) => r.account_number === accountNumber)
  if (!row) throw new Error(`account ${accountNumber} is not in the report`)
  return Object.fromEntries(report.columns.map((c, i) => [c.code ?? '', row.values[i]]))
}

function netByColumn(report: DimensionPnlReport): Record<string, number> {
  return Object.fromEntries(report.columns.map((c, i) => [c.code ?? '', report.net_per_column[i]]))
}

beforeAll(async () => {
  client = createToolPgClient()
  const seeded = await seedCompany()
  companyId = seeded.companyId
  userId = seeded.userId
  fiscalPeriodId = seeded.fiscalPeriodId
  const entry = { userId, companyId, fiscalPeriodId }

  // Every writer (the engine, a SIE import, a booking template, a retag)
  // stores the same thing: a bag on the line keyed by SIE dimension number.
  // One projekt value per sale, one untagged sale:
  await insertPostedJournalEntry({
    ...entry, voucherNumber: 1, entryDate: '2026-02-01',
    lines: [
      { accountNumber: '1930', debitAmount: 1000, creditAmount: 0 },
      { accountNumber: '3001', debitAmount: 0, creditAmount: 1000, dimensions: { '6': 'P1' } },
    ],
  })
  await insertPostedJournalEntry({
    ...entry, voucherNumber: 2, entryDate: '2026-03-01',
    lines: [
      { accountNumber: '1930', debitAmount: 600, creditAmount: 0 },
      { accountNumber: '3001', debitAmount: 0, creditAmount: 600, dimensions: { '6': 'P2' } },
    ],
  })
  await insertPostedJournalEntry({
    ...entry, voucherNumber: 3, entryDate: '2026-03-15',
    lines: [
      { accountNumber: '1930', debitAmount: 300, creditAmount: 0 },
      { accountNumber: '3001', debitAmount: 0, creditAmount: 300 },
    ],
  })
  // A cost on a kostnadsställe (dimension 1) and on a company-defined
  // dimension (20), with no projekt:
  await insertPostedJournalEntry({
    ...entry, voucherNumber: 4, entryDate: '2026-04-01',
    lines: [
      { accountNumber: '5010', debitAmount: 200, creditAmount: 0, dimensions: { '1': 'KS01', '20': 'X' } },
      { accountNumber: '1930', debitAmount: 0, creditAmount: 200 },
    ],
  })
  // A cost on a projekt and a kostnadsställe at once:
  await insertPostedJournalEntry({
    ...entry, voucherNumber: 5, entryDate: '2026-05-01',
    lines: [
      { accountNumber: '6110', debitAmount: 50, creditAmount: 0, dimensions: { '1': 'KS01', '6': 'P1' } },
      { accountNumber: '1930', debitAmount: 0, creditAmount: 50 },
    ],
  })

  // The registry names the columns. P1 is registered, P2 is a code only the
  // lines know (a tag from before the registry, or from an import).
  await getPool().query('SELECT public.ensure_company_dimensions($1)', [companyId])
  await getPool().query(
    `INSERT INTO public.dimension_values (company_id, dimension_id, code, name)
     SELECT $1, d.id, 'P1', 'Projekt ett' FROM public.dimensions d
      WHERE d.company_id = $1 AND d.sie_dim_no = 6`,
    [companyId],
  )
}, 60_000)

describe('per-dimension result against real PostgREST', () => {
  it('splits the result over the projekt values the lines carry (the MCP tool, as reported)', async () => {
    const tool = tools.find((t) => t.name === 'gnubok_get_dimension_pnl')
    if (!tool) throw new Error('gnubok_get_dimension_pnl is not registered')

    const report = (await tool.execute(
      { sie_dim_no: '6', period_id: fiscalPeriodId },
      companyId,
      userId,
      client as never,
      { type: 'api_key' },
    )) as DimensionPnlReport

    // One column per value, then the untagged remainder: not one null column
    // holding the whole result.
    expect(report.dimension).toEqual({ sie_dim_no: '6', name: 'Projekt' })
    expect(report.columns).toEqual([
      { code: 'P1', name: 'Projekt ett' },
      { code: 'P2', name: null },
      { code: null, name: null },
    ])
    expect(byColumn(report, '3001')).toEqual({ P1: 1000, P2: 600, '': 300 })
    expect(byColumn(report, '5010')).toEqual({ P1: 0, P2: 0, '': -200 })
    expect(byColumn(report, '6110')).toEqual({ P1: -50, P2: 0, '': 0 })
    expect(netByColumn(report)).toEqual({ P1: 950, P2: 600, '': 100 })
    expect(report.net_total).toBe(1650)
  })

  it('reads dimension 1 and a company-defined dimension the same way', async () => {
    const costCenter = await generateDimensionPnl(client, companyId, fiscalPeriodId, '1')
    expect(costCenter.columns.map((c) => c.code)).toEqual(['KS01', null])
    expect(byColumn(costCenter, '3001')).toEqual({ KS01: 0, '': 1900 })
    expect(byColumn(costCenter, '5010')).toEqual({ KS01: -200, '': 0 })
    expect(byColumn(costCenter, '6110')).toEqual({ KS01: -50, '': 0 })
    expect(netByColumn(costCenter)).toEqual({ KS01: -250, '': 1900 })

    const custom = await generateDimensionPnl(client, companyId, fiscalPeriodId, '20')
    expect(custom.columns.map((c) => c.code)).toEqual(['X', null])
    expect(byColumn(custom, '5010')).toEqual({ X: -200, '': 0 })
    expect(netByColumn(custom)).toEqual({ X: -200, '': 1850 })

    // A dimension no line carries: the whole result is untagged, and says so.
    const unused = await generateDimensionPnl(client, companyId, fiscalPeriodId, '7')
    expect(unused.columns.map((c) => c.code)).toEqual([null])
    expect(netByColumn(unused)).toEqual({ '': 1650 })
  })

  it('agrees, value by value, with the readers that filter on the same bag', async () => {
    const report = await generateDimensionPnl(client, companyId, fiscalPeriodId, '6')
    const net = netByColumn(report)

    for (const code of ['P1', 'P2']) {
      // The dimension-filtered resultatrapport (jsonb containment in the
      // trial-balance RPC).
      const filtered = await resultatrapportRows(client, companyId, fiscalPeriodId, {
        dimensions: { '6': code },
      })
      const filteredNet = filtered.reduce((sum, row) => sum + signedAmount(row), 0)
      expect(net[code], `resultatrapport filtered on ${code}`).toBe(filteredNet)

      // The general ledger under the same filter (containment through
      // PostgREST's cs operator), class 3-8 accounts.
      const ledger = await generateGeneralLedger(client, companyId, fiscalPeriodId, '3000', '8999', {
        dimensions: { '6': code },
      })
      const ledgerNet = ledger.accounts
        .flatMap((a) => a.lines)
        .reduce((sum, line) => sum + line.credit - line.debit, 0)
      expect(net[code], `general ledger filtered on ${code}`).toBe(ledgerNet)
    }

    // The columns add up to the unfiltered result.
    const unfiltered = await resultatrapportRows(client, companyId, fiscalPeriodId)
    expect(report.net_total).toBe(unfiltered.reduce((sum, row) => sum + signedAmount(row), 0))
    expect(Object.values(net).reduce((sum, v) => sum + v, 0)).toBe(report.net_total)
  })

  it('matches the generated cost_center and project columns, the deprecated aliases of keys 1 and 6', async () => {
    // The aliases are not a second store: both columns are GENERATED from the
    // bag, so a line the report counts under a value is the line they name.
    const { rows } = await getPool().query<{ project: string | null; cost_center: string | null; net: string }>(
      `SELECT l.project, l.cost_center, sum(l.credit_amount - l.debit_amount)::text AS net
         FROM public.journal_entry_lines l
         JOIN public.journal_entries e ON e.id = l.journal_entry_id
        WHERE e.company_id = $1 AND l.account_number >= '3' AND l.account_number < '9'
        GROUP BY l.project, l.cost_center`,
      [companyId],
    )
    const sumWhere = (pick: (r: (typeof rows)[number]) => boolean) =>
      rows.filter(pick).reduce((sum, r) => sum + Number(r.net), 0)

    const project = netByColumn(await generateDimensionPnl(client, companyId, fiscalPeriodId, '6'))
    expect(project.P1).toBe(sumWhere((r) => r.project === 'P1'))
    expect(project.P2).toBe(sumWhere((r) => r.project === 'P2'))
    expect(project['']).toBe(sumWhere((r) => r.project === null))

    const costCenter = netByColumn(await generateDimensionPnl(client, companyId, fiscalPeriodId, '1'))
    expect(costCenter.KS01).toBe(sumWhere((r) => r.cost_center === 'KS01'))
    expect(costCenter['']).toBe(sumWhere((r) => r.cost_center === null))
  })

  it('keeps the trial balance filter, the nearest thing to a balance report per dimension, on the same bag', async () => {
    // Balance sheet and balansrapport refuse a dimension filter by design
    // (dimension-statutory-guard.test.ts); the trial balance is the one
    // balance-shaped reader that takes it, and it uses containment.
    const tb = await generateTrialBalance(client, companyId, fiscalPeriodId, {
      closingEntry: 'include',
      dimensions: { '6': 'P1' },
    })
    expect(tb.rows.map((r) => [r.account_number, r.period_debit, r.period_credit])).toEqual([
      ['3001', 0, 1000],
      ['6110', 50, 0],
    ])
  })
})
