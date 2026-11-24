/**
 * The flerårsöversikt in the rendered K2 and K3 PDFs: whole kronor by
 * default, thousands of kronor when the year asks for it
 * (forvaltningsberattelse.flerarsoversikt_tkr). The tkr figures are the ones
 * the iXBRL document tags (roundThousands), so the PDF and the filed document
 * state the same numbers; the statements stay in whole kronor.
 */
import { describe, expect, it } from 'vitest'
import { renderToBuffer } from '@react-pdf/renderer'
import { ArsredovisningPDF } from '../arsredovisning-pdf'
import { ArsredovisningK3PDF } from '../arsredovisning-k3-pdf'
import type { ArsredovisningData } from '../types'
import { pdfTextStrings } from '@/tests/pdf-text'

const RENDER_TIMEOUT = 30_000

function report(framework: 'k2' | 'k3', tkr: boolean | undefined): ArsredovisningData {
  return {
    company: { name: 'Testbolaget AB', org_number: '556677-8899', entity_type: 'aktiebolag', registered_office: 'Stockholm' },
    fiscal_period: { id: 'fp1', name: '2025', period_start: '2025-01-01', period_end: '2025-12-31' },
    previous_period: null,
    accounting_framework: framework,
    forvaltningsberattelse: {
      description: 'Bolaget bedriver konsultverksamhet.',
      important_events: 'Inga väsentliga händelser.',
      kontrollbalans_required: false,
      // An exact zero and a loss on a half, an amount under 500 kr, an exact half and a loss.
      flerarsoversikt: [
        { year: '2023', net_revenue: 0, result_after_financial: -1_500, soliditet_pct: 100 },
        { year: '2024', net_revenue: 400, result_after_financial: 400, soliditet_pct: 98.4 },
        { year: '2025', net_revenue: 2_650_500, result_after_financial: -4_684, soliditet_pct: 81.6 },
      ],
      ...(tkr === undefined ? {} : { flerarsoversikt_tkr: tkr }),
      egen_kapital_changes: [{ label: 'Aktiekapital', amount: 25_000 }],
      resultatdisposition: 'Styrelsen föreslår att årets resultat balanseras i ny räkning.',
      proposed_dividend: 0,
      resultatdisposition_amounts: {
        retained_earnings: 400,
        share_premium_reserve: 0,
        current_year_result: -4_684,
        total: -4_284,
        proposed_dividend: 0,
        carried_forward: -4_284,
      },
      agm_date: null,
      member_disclosures: null,
      agm_disposition_outcome: null,
      agm_disposition_decision: null,
    },
    resultatrakning: [{ label: 'Nettoomsättning', current: 2_650_500, previous: null, indent: 1 }],
    balansrakning: {
      assets: [],
      total_assets: 20_716,
      total_assets_previous: null,
      equity_liabilities: [],
      total_equity_liabilities: 20_716,
      total_equity_liabilities_previous: null,
    },
    noter: [],
    signatures: [],
    warnings: [],
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

const TEMPLATES = [
  ['K2', 'k2', ArsredovisningPDF],
  ['K3', 'k3', ArsredovisningK3PDF],
] as const

/** The text of every page, sorted: the page streams of two renders come in no fixed order. */
async function pages(element: Parameters<typeof renderToBuffer>[0]): Promise<string[]> {
  return pdfTextStrings(await renderToBuffer(element)).sort()
}

async function text(element: Parameters<typeof renderToBuffer>[0]): Promise<string> {
  return (await pages(element)).join('\n')
}

describe.each(TEMPLATES)('flerårsöversikt in the %s PDF', (_name, framework, Template) => {
  it('prints whole kronor by default', async () => {
    const pdf = await text(Template({ data: report(framework, undefined) }))
    expect(pdf).toContain('Flerårsöversikt (kr)')
    expect(pdf).not.toContain('Flerårsöversikt (tkr)')
    // Year, nettoomsättning, resultat efter finansiella poster, soliditet.
    expect(pdf).toContain('20230-1 500100.0')
    expect(pdf).toContain('202440040098.4')
    expect(pdf).toContain('20252 650 500-4 68481.6')
  }, RENDER_TIMEOUT)

  it('prints the same with the choice off', async () => {
    const off = await pages(Template({ data: report(framework, false) }))
    expect(off).toEqual(await pages(Template({ data: report(framework, undefined) })))
  }, RENDER_TIMEOUT)

  it('prints thousands of kronor when the year asks for it, a half away from zero', async () => {
    const pdf = await text(Template({ data: report(framework, true) }))
    expect(pdf).toContain('Flerårsöversikt (tkr)')
    expect(pdf).not.toContain('Flerårsöversikt (kr)')
    // 0 kr and -1 500 kr; 400 kr twice; 2 650 500 kr and -4 684 kr.
    expect(pdf).toContain('20230-2100.0')
    expect(pdf).toContain('20240098.4')
    expect(pdf).toContain('20252 651-581.6')
    // Soliditet keeps its heading, and the statements stay in whole kronor.
    expect(pdf).toContain('Soliditet (%)')
    expect(pdf).toContain('Resultaträkning (kr)')
    expect(pdf).toContain('2 650 500')
  }, RENDER_TIMEOUT)
})
