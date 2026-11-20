import { describe, it, expect } from 'vitest'
import { renderToBuffer } from '@react-pdf/renderer'
import { KassaflodesanalysPDF } from '../kassaflodesanalys-pdf-template'
import type { KassaflodesanalysFullReport } from '../kassaflodesanalys'
import {
  buildKassaflodesanalysYear,
  likvidaMedelDefinition,
  type KassaflodesanalysYear,
} from '@/lib/reports/kassaflodesanalys-statement'
import type { CompanySettings, TrialBalanceRow } from '@/types'
import { pdfTextStrings } from '@/tests/pdf-text'

function fakeCompany(): CompanySettings {
  return {
    company_name: 'Testbolaget AB',
    org_number: '5566778899',
  } as unknown as CompanySettings
}

/** A trial-balance row from IB and period movement (debit positive). */
function row(account: string, opening: number, movement: number): TrialBalanceRow {
  const closing = opening + movement
  return {
    account_number: account,
    account_name: account,
    account_class: Number(account[0]),
    opening_debit: Math.max(0, opening),
    opening_credit: Math.max(0, -opening),
    period_debit: Math.max(0, movement),
    period_credit: Math.max(0, -movement),
    closing_debit: Math.max(0, closing),
    closing_credit: Math.max(0, -closing),
  }
}

function year(
  start: string,
  end: string,
  rows: TrialBalanceRow[],
  vouchers: Map<string, number>[] | null = null,
): KassaflodesanalysYear {
  return buildKassaflodesanalysYear({
    periodStart: start,
    periodEnd: end,
    rows,
    tax: { paidIncomeTax: 0, otherTaxLiabilityChange: 0, expenseInOperatingProfit: 0 },
    vouchers,
    definition: likvidaMedelDefinition(start),
  })
}

function report(
  current: KassaflodesanalysYear,
  previous: KassaflodesanalysYear | null = null,
): KassaflodesanalysFullReport {
  return {
    // The summary sections are not printed by this template.
    fiscal_period_id: 'fp-1',
    period_start: '2026-01-01',
    period_end: '2026-12-31',
    lopande: {
      resultat_efter_finansiella_poster: 0, avskrivningar: 0, ovriga_ej_kassaflodesposter: 0,
      delta_kortfristiga_fordringar: 0, delta_varulager: 0, delta_kortfristiga_skulder: 0,
      skatt_betald: 0, koncernbidrag: 0, ovriga_poster: 0, total: 0,
    },
    investerings: { forvarv_anlaggningar: 0, avyttring_anlaggningar: 0, kortfristiga_placeringar: 0, total: 0 },
    finansierings: { delta_lan: 0, utdelningar: 0, nyemission: 0, erhallna_aktieagartillskott: 0, total: 0 },
    total_cash_flow: 0,
    unclassified_accounts: [],
    reconciliation: {
      opening_cash_1xxx: 0, closing_cash_1xxx: 0, delta_actual: 0, delta_calculated: 0,
      mismatch_amount: 0, is_reconciled: true,
    },
    statement: {
      method: 'indirect',
      current,
      previous,
      previous_status: previous ? 'included' : 'not_requested',
    },
  }
}

async function render(input: KassaflodesanalysFullReport) {
  return pdfTextStrings(
    await renderToBuffer(
      KassaflodesanalysPDF({ report: input, company: fakeCompany(), generatedAt: '2026-08-29T10:00:00Z' }),
    ),
  ).join('\n')
}

describe('KassaflodesanalysPDF', () => {
  it('prints negative cash flows with an ASCII minus the bundled font can draw (issue #1982)', async () => {
    const text = await render(report(year('2026-01-01', '2026-12-31', [
      row('1930', 50_000, -15_634.74),
      row('5010', 0, 4_684.24), // a cost paid
      row('1220', 0, 12_000), // inventarier bought
      row('1510', 0, -1_049.5), // receivables collected
      row('2091', -50_000, 0),
    ])))

    expect(text).toContain('-4 684,24')
    expect(text).toContain('-12 000,00')
    expect(text).toContain('-15 634,74')
    expect(text).not.toContain(String.fromCharCode(0x12))
    expect(text).not.toContain('−')
    expect(text).toContain('Indirekt metod enligt K3 kapitel 7')
    expect(text).toContain('Investeringar i materiella anläggningstillgångar')
    // Lines that are zero stay out of the statement.
    expect(text).not.toContain('Övriga poster')
    expect(text).not.toContain('Erlagd ränta')
    expect(text).not.toContain('Kursdifferens i likvida medel')
  }, 30_000)

  it('prints interest, gross loans, the kursdifferens and the named Övriga poster when they moved', async () => {
    const text = await render(report(year('2026-01-01', '2026-12-31', [
      row('1930', 100_000, 297_200),
      row('1980', 20_000, 1_000),
      row('8331', 0, -1_000), // a currency account revalued: kursdifferens
      row('8410', 0, 3_300), // interest paid
      row('2350', -200_000, -300_000), // borrowed
      row('9999', 0, -500),
      row('2091', 80_000, 0),
      row('3001', 0, -500),
      row('1510', 0, 500),
    ], [new Map([['1980', 1_000], ['8331', -1_000]])])))

    expect(text).toContain('Erlagd ränta')
    expect(text).toContain('-3 300,00')
    expect(text).toContain('Upptagna lån')
    expect(text).toContain('300 000,00')
    expect(text).toContain('Kursdifferens i likvida medel')
    expect(text).toContain('Övriga poster (konto 9999)')
    expect(text).toContain('Avstämning mot likvida medel')
  }, 30_000)

  it('prints the comparative year beside the year', async () => {
    const previous = year('2025-01-01', '2025-12-31', [row('1930', 10_000, 7_777), row('3001', 0, -7_777), row('2091', -10_000, 0)])
    const current = year('2026-01-01', '2026-12-31', [row('1930', 17_777, 1_000), row('3001', 0, -1_000), row('2091', -17_777, 0)])
    const text = await render(report(current, previous))

    expect(text).toContain('2026')
    expect(text).toContain('2025')
    expect(text).toContain('7 777,00')
    expect(text).toContain('Likvida medel vid årets början')
  }, 30_000)
})
