/**
 * Issue #1982: a loss printed as a profit in the årsredovisning PDF.
 *
 * sv-SE number formatting writes negatives with U+2212 MINUS SIGN. The
 * bundled Helvetica has no glyph for it, so the rendered document carried an
 * unmapped byte where the sign should be and "Årets resultat" read as
 * +4 684 while "Summa eget kapital" (20 316) only reconciled with -4 684.
 * These tests decode the content streams of the real render, which is the
 * only place the bug is visible: the element tree always had the sign.
 */
import { describe, it, expect } from 'vitest'
import { renderToBuffer } from '@react-pdf/renderer'
import { ArsredovisningPDF } from '../arsredovisning-pdf'
import { ArsredovisningK3PDF } from '../arsredovisning-k3-pdf'
import type { ArsredovisningData } from '../types'
import { pdfTextStrings } from '@/tests/pdf-text'

const RENDER_TIMEOUT = 30_000

/** Unmapped-glyph byte react-pdf emits for U+2212 in a WinAnsi font. */
const UNMAPPED = String.fromCharCode(0x12)

function makeLossYearData(framework: 'k2' | 'k3'): ArsredovisningData {
  return {
    company: {
      name: 'Testbolaget AB',
      org_number: '556677-8899',
      entity_type: 'aktiebolag',
      city: 'Stockholm',
    },
    fiscal_period: {
      id: 'fp1',
      name: 'Första räkenskapsåret 2025/2026',
      period_start: '2025-10-14',
      period_end: '2026-01-31',
    },
    previous_period: null,
    accounting_framework: framework,
    forvaltningsberattelse: {
      description: 'Bolaget bedriver konsultverksamhet inom IT.',
      important_events: 'Inga väsentliga händelser.',
      kontrollbalans_required: false,
      flerarsoversikt: [
        { year: '2025/2026', net_revenue: 0, result_after_financial: -4684, soliditet_pct: 100 },
      ],
      egen_kapital_changes: [
        { label: 'Aktiekapital', amount: 25_000 },
        { label: 'Årets resultat', amount: -4684 },
        { label: 'Summa eget kapital', amount: 20_316 },
      ],
      resultatdisposition: 'Styrelsen föreslår att årets förlust balanseras i ny räkning.',
      proposed_dividend: 0,
      resultatdisposition_amounts: {
        retained_earnings: 0,
        share_premium_reserve: 0,
        current_year_result: -4684,
        total: -4684,
        proposed_dividend: 0,
        carried_forward: -4684,
      },
      agm_date: '2026-06-15',
      agm_disposition_outcome: 'proposal_approved',
      agm_disposition_decision: null,
    },
    resultatrakning: [
      { label: 'Rörelsekostnader', current: null, previous: null, is_heading: true },
      { label: 'Övriga externa kostnader', current: -4684, previous: null, indent: 1 },
      { label: 'Summa rörelsekostnader', current: -4684, previous: null, is_total: true },
      { label: 'Rörelseresultat', current: -4684, previous: null, is_total: true },
      {
        label: 'Årets resultat',
        current: -4684,
        previous: null,
        is_total: true,
        semantic_key: 'income_statement_result',
      },
    ],
    balansrakning: {
      assets: [
        { label: 'Kassa och bank', current: 20_316, previous: null, indent: 2 },
        { label: 'Summa tillgångar', current: 20_316, previous: null, is_total: true },
      ],
      total_assets: 20_316,
      total_assets_previous: null,
      equity_liabilities: [
        { label: 'Eget kapital', current: null, previous: null, is_heading: true },
        { label: 'Aktiekapital', current: 25_000, previous: null, indent: 2 },
        { label: 'Balanserat resultat', current: 0, previous: null, indent: 2 },
        {
          label: 'Årets resultat',
          current: -4684,
          previous: null,
          indent: 2,
          semantic_key: 'balance_sheet_current_year_result',
        },
        { label: 'Summa fritt eget kapital', current: -4684, previous: null, is_total: true, indent: 1 },
        { label: 'Summa eget kapital', current: 20_316, previous: null, is_total: true },
        { label: 'Summa eget kapital och skulder', current: 20_316, previous: null, is_total: true },
      ],
      total_equity_liabilities: 20_316,
      total_equity_liabilities_previous: null,
    },
    noter: [
      {
        number: 1,
        title: 'Redovisnings- och värderingsprinciper',
        body: 'Årsredovisningen är upprättad enligt BFNAR 2016:10.',
      },
    ],
    signatures: [],
    warnings: [],
    disclosures: {
      long_term_debt_over_five_years: null,
      securities_pledged: null,
      contingent_liabilities: null,
      parent_company_name: null,
      parent_company_org_number: null,
      parent_company_city: null,
      confirmations: {
        long_term_debt_over_five_years: true,
        securities_pledged: true,
        contingent_liabilities: true,
        parent_company: true,
      },
    },
  }
}

function expectSignedLoss(pages: string[]): void {
  const text = pages.join('\n')
  // The sign reaches the file as an ASCII hyphen the font can draw ...
  expect(text).toContain('-4 684')
  // ... and never as the unmapped byte a WinAnsi font draws as nothing.
  expect(text).not.toContain(UNMAPPED)
  expect(text).not.toContain('−')
  // The positive totals are untouched.
  expect(text).toContain('20 316')
  expect(text).toContain('25 000')
}

describe('årsredovisning PDF keeps the sign of a loss (issue #1982)', () => {
  it('K2: Årets resultat and Summa fritt eget kapital print as -4 684', async () => {
    const buffer = await renderToBuffer(ArsredovisningPDF({ data: makeLossYearData('k2') }))
    expectSignedLoss(pdfTextStrings(buffer))
  }, RENDER_TIMEOUT)

  it('K3: the same rows print signed', async () => {
    const buffer = await renderToBuffer(ArsredovisningK3PDF({ data: makeLossYearData('k3') }))
    expectSignedLoss(pdfTextStrings(buffer))
  }, RENDER_TIMEOUT)
})
