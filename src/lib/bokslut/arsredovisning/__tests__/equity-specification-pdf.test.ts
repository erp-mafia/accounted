/**
 * The specification of changes in equity in the rendered K2 and K3 PDFs:
 * the K2 förvaltningsberättelse used to print the equity posts at year end
 * only; it now prints the roll-forward from last year's balance sheet that
 * ÅRL 6 kap. 2 § andra stycket asks for, from the same specification the K3
 * document and the K2 iXBRL read. A version saved before the specification
 * keeps rendering what it stored, and one saved before the K2 taxonomy's row
 * labels keeps the labels it was signed with.
 */
import { describe, expect, it } from 'vitest'
import { renderToBuffer } from '@react-pdf/renderer'
import { ArsredovisningPDF } from '../arsredovisning-pdf'
import { ArsredovisningK3PDF } from '../arsredovisning-k3-pdf'
import { buildEquitySpecification, k2EquityPosts } from '../equity-specification'
import type { ArsredovisningData } from '../types'
import { pdfTextStrings } from '@/tests/pdf-text'

const RENDER_TIMEOUT = 30_000

function tb(account: string, opening: number, closing: number) {
  return {
    account_number: account,
    opening_debit: 0,
    opening_credit: opening,
    closing_debit: 0,
    closing_credit: closing,
  }
}

const SPEC = buildEquitySpecification({
  posts: k2EquityPosts('aktiebolag'),
  current: {
    fiscal_period_id: 'fp1',
    name: '2025',
    period_start: '2025-01-01',
    period_end: '2025-12-31',
    tbRows: [tb('2081', 25_000, 25_000), tb('2098', 40_000, 50_000), tb('2099', 30_000, 12_345)],
    entries: [
      {
        id: 'je-disp',
        voucher: 'A1',
        entry_date: '2025-01-01',
        description: null,
        source_type: 'result_appropriation',
        reverses_id: null,
        lines: [
          { account_number: '2099', debit: 30_000, credit: 0 },
          { account_number: '2098', debit: 0, credit: 30_000 },
        ],
      },
      {
        id: 'je-utd',
        voucher: 'A2',
        entry_date: '2025-05-01',
        description: null,
        source_type: 'manual',
        reverses_id: null,
        lines: [
          { account_number: '2098', debit: 20_000, credit: 0 },
          { account_number: '2898', debit: 0, credit: 20_000 },
        ],
      },
      {
        id: 'je-close',
        voucher: 'A99',
        entry_date: '2025-12-31',
        description: null,
        source_type: 'year_end',
        reverses_id: null,
        lines: [
          { account_number: '8999', debit: 12_345, credit: 0 },
          { account_number: '2099', debit: 0, credit: 12_345 },
        ],
      },
    ],
  },
  previous: null,
  balanceSheet: {
    br: {
      Aktiekapital: { current: 25_000, previous: null },
      BalanseratResultat: { current: 50_000, previous: null },
      AretsResultatEgetKapital: { current: 12_345, previous: null },
    },
    totals: { egetKapital: { current: 87_345, previous: null } },
  } as never,
})

function report(framework: 'k2' | 'k3', withSpec: boolean): ArsredovisningData {
  return {
    company: { name: 'Testbolaget AB', org_number: '556677-8899', entity_type: 'aktiebolag', registered_office: 'Stockholm' },
    fiscal_period: { id: 'fp1', name: '2025', period_start: '2025-01-01', period_end: '2025-12-31' },
    previous_period: null,
    accounting_framework: framework,
    forvaltningsberattelse: {
      description: 'Bolaget bedriver konsultverksamhet.',
      important_events: 'Inga väsentliga händelser.',
      kontrollbalans_required: false,
      flerarsoversikt: [],
      egen_kapital_changes: [
        { label: 'Aktiekapital', amount: 25_000 },
        { label: 'Balanserat resultat', amount: 50_000 },
        { label: 'Årets resultat', amount: 12_345 },
        { label: 'Summa eget kapital', amount: 87_345 },
      ],
      resultatdisposition: 'Styrelsen föreslår att årets resultat balanseras i ny räkning.',
      proposed_dividend: 0,
      resultatdisposition_amounts: {
        retained_earnings: 50_000,
        share_premium_reserve: 0,
        current_year_result: 12_345,
        total: 62_345,
        proposed_dividend: 0,
        carried_forward: 62_345,
      },
      agm_date: null,
      member_disclosures: null,
      agm_disposition_outcome: null,
      agm_disposition_decision: null,
    },
    resultatrakning: [],
    balansrakning: {
      assets: [],
      total_assets: 87_345,
      total_assets_previous: null,
      equity_liabilities: [],
      total_equity_liabilities: 87_345,
      total_equity_liabilities_previous: null,
    },
    noter: [],
    signatures: [],
    warnings: [],
    ...(withSpec ? { equity_specification: SPEC } : {}),
    disclosures: {
      long_term_debt_over_five_years: null,
      securities_pledged: null,
      contingent_liabilities: null,
      parent_company_name: null,
      parent_company_org_number: null,
      parent_company_city: null,
      medelantal_anstallda_override: null,
      omit_kassaflodesanalys: false,
      kassaflodesanalys_omission_confirmed: false,
      confirmations: {
        long_term_debt_over_five_years: true,
        securities_pledged: true,
        contingent_liabilities: true,
        parent_company: true,
      },
    },
  }
}

async function text(element: Parameters<typeof renderToBuffer>[0]): Promise<string> {
  return pdfTextStrings(await renderToBuffer(element)).join('\n')
}

/** How many times the PDF prints a phrase (the resultatdisposition prints "Balanseras i ny räkning" too). */
const count = (pdf: string, phrase: string): number => pdf.split(phrase).length - 1

describe('equity specification in the PDFs', () => {
  it('K2: prints the roll-forward from the opening balance through the movements', async () => {
    // A report built today says it prints the K2 taxonomy's row labels.
    const data = report('k2', true)
    data.equity_specification = { ...SPEC, row_labels: 'k2' }
    const pdf = await text(ArsredovisningPDF({ data }))
    expect(pdf).toContain('Belopp vid årets ingång')
    // The K2 taxonomy's own row labels, as the iXBRL document prints them:
    // "Balanseras i ny räkning" once in the table, once in the resultatdisposition.
    expect(count(pdf, 'Balanseras i ny räkning')).toBe(2)
    expect(pdf).toContain('Vinstutdelning')
    expect(pdf).not.toContain('Disposition enligt stämmans beslut')
    expect(pdf).toContain('Belopp vid årets utgång')
    expect(pdf).toContain('-20 000')
    expect(pdf).toContain('87 345')
  }, RENDER_TIMEOUT)

  it('K2: a version saved before the K2 taxonomy\'s row labels prints the labels it was signed with', async () => {
    const data = report('k2', true)
    expect(data.equity_specification).not.toHaveProperty('row_labels')
    const pdf = await text(ArsredovisningPDF({ data }))
    expect(pdf).toContain('Disposition enligt stämmans beslut')
    expect(pdf).toContain('Utdelning')
    expect(count(pdf, 'Balanseras i ny räkning')).toBe(1)
    expect(pdf).not.toContain('Vinstutdelning')
    // The same figures either way.
    expect(pdf).toContain('-20 000')
    expect(pdf).toContain('87 345')
  }, RENDER_TIMEOUT)

  it('K2: a version saved before the specification prints its year-end list as before', async () => {
    const pdf = await text(ArsredovisningPDF({ data: report('k2', false) }))
    expect(pdf).toContain('Summa eget kapital')
    expect(pdf).not.toContain('Belopp vid årets ingång')
  }, RENDER_TIMEOUT)

  it('K3: prints it in förvaltningsberättelsen by default, with no page of its own', async () => {
    const pdf = await text(ArsredovisningK3PDF({ data: report('k3', true) }))
    expect(pdf).toContain('Belopp vid årets ingång')
    expect(pdf.match(/Förändring av eget kapital \(kr\)/g)).toHaveLength(1)
    // K3 keeps its own row labels (K3 6.3), not the K2 taxonomy's.
    expect(pdf).toContain('Disposition enligt stämmans beslut')
    expect(pdf).not.toContain('Vinstutdelning')
  }, RENDER_TIMEOUT)

  it('K3: prints it as a statement of its own when chosen', async () => {
    const data = report('k3', true)
    data.equity_specification = { ...SPEC, placement: 'separate_statement' }
    const pdf = await text(ArsredovisningK3PDF({ data }))
    expect(pdf.match(/Förändring av eget kapital \(kr\)/g)).toHaveLength(1)
    expect(pdf).toContain('Belopp vid årets utgång')
  }, RENDER_TIMEOUT)
})
