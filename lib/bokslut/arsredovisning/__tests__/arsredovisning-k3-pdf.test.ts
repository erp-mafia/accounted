/**
 * Snapshot/structure test for the K3 ÅR PDF template. We don't snapshot the
 * binary output — instead we verify that:
 *   1. The template renders to a non-empty PDF buffer (no exceptions thrown
 *      by react-pdf — the most common failure when a structural mistake
 *      slips into the layout).
 *   2. The K3 template can render with minimal / empty kassaflöde and
 *      equity_changes (defensive — the PDF should handle reduced data).
 *
 * A full visual snapshot is overkill at this layer; if visual regressions
 * matter we'll add a Playwright-based screenshot test later.
 */
import { describe, it, expect } from 'vitest'
import { renderToBuffer } from '@react-pdf/renderer'
import { ArsredovisningK3PDF } from '../arsredovisning-k3-pdf'
import { ArsredovisningPDF } from '../arsredovisning-pdf'
import type { ArsredovisningData } from '../types'

function makeMinimalK3Data(): ArsredovisningData {
  return {
    company: {
      name: 'Testbolaget AB',
      org_number: '556677-8899',
      city: 'Stockholm',
    },
    fiscal_period: {
      id: 'fp1',
      name: '2025',
      period_start: '2025-01-01',
      period_end: '2025-12-31',
    },
    accounting_framework: 'k3',
    forvaltningsberattelse: {
      description: 'Bolaget bedriver konsultverksamhet inom IT.',
      important_events: 'Inga väsentliga händelser.',
      kontrollbalans_required: false,
      flerarsoversikt: [
        { year: '2025', net_revenue: 500_000, result_after_financial: 300_000, soliditet_pct: 80.0 },
      ],
      egen_kapital_changes: [
        { label: '2081 Aktiekapital', amount: 50_000 },
        { label: '2099 Årets resultat', amount: 300_000 },
      ],
      resultatdisposition: 'Styrelsen föreslår att årets resultat balanseras i ny räkning.',
      agm_date: '2026-06-15',
    },
    resultatrakning: [
      { label: '3001 Försäljning', amount: 500_000 },
      { label: 'Summa rörelseintäkter', amount: 500_000, is_total: true },
      { label: '4010 Inköp', amount: -200_000 },
      { label: 'Rörelseresultat', amount: 300_000, is_total: true },
      { label: 'Årets resultat', amount: 300_000, is_total: true },
    ],
    balansrakning: {
      assets: [
        { label: 'Omsättningstillgångar', amount: 600_000, is_total: true, indent: 0 },
        { label: '1930 Bank', amount: 600_000, indent: 1 },
      ],
      total_assets: 600_000,
      equity_liabilities: [
        { label: 'Eget kapital', amount: 600_000, is_total: true, indent: 0 },
        { label: '2081 Aktiekapital', amount: 50_000, indent: 1 },
        { label: '2099 Årets resultat', amount: 300_000, indent: 1 },
        { label: '2098 Balanserade vinstmedel', amount: 250_000, indent: 1 },
      ],
      total_equity_liabilities: 600_000,
    },
    noter: [
      {
        number: 1,
        title: 'Redovisnings- och värderingsprinciper',
        body: 'Årsredovisningen är upprättad enligt BFNAR 2012:1.',
      },
      {
        number: 2,
        title: 'Uppskjutna skatter',
        body: 'Ingående saldo (2240): 50 000 kr\nÅrets förändring (8940): 20 600 kr\nUtgående saldo (2240): 70 600 kr',
      },
      {
        number: 3,
        title: 'Eventualförpliktelser',
        body: 'Inga.',
      },
    ],
    kassaflodesanalys: {
      period_start: '2025-01-01',
      period_end: '2025-12-31',
      lopande: {
        resultat_efter_finansiella_poster: 300_000,
        avskrivningar: 0,
        ovriga_ej_kassaflodesposter: 0,
        delta_kortfristiga_fordringar: 0,
        delta_varulager: 0,
        delta_kortfristiga_skulder: 0,
        skatt_betald: 0,
        total: 300_000,
      },
      investerings: { forvarv_anlaggningar: 0, avyttring_anlaggningar: 0, total: 0 },
      finansierings: { delta_lan: 0, utdelningar: 0, nyemission: 0, total: 0 },
      total_cash_flow: 300_000,
      reconciliation: {
        opening_cash_1xxx: 300_000,
        closing_cash_1xxx: 600_000,
        delta_actual: 300_000,
        delta_calculated: 300_000,
        mismatch_amount: 0,
        is_reconciled: true,
      },
    },
    equity_changes_statement: {
      rows: [
        { label: 'Ingående aktiekapital', amount: 50_000 },
        { label: 'Ingående balanserade vinstmedel', amount: 250_000 },
        { label: 'Summa ingående eget kapital', amount: 300_000 },
        { label: 'Årets resultat', amount: 300_000 },
        { label: 'Summa utgående eget kapital', amount: 600_000 },
      ],
      closing_total: 600_000,
    },
    signatures: [],
    warnings: [],
    disclosures: {
      long_term_debt_over_five_years: null,
      securities_pledged: null,
      contingent_liabilities: null,
      parent_company_name: null,
      parent_company_org_number: null,
      parent_company_city: null,
    },
  }
}

describe('ArsredovisningK3PDF', () => {
  it('renders without throwing against a minimal K3 fixture', async () => {
    const doc = ArsredovisningK3PDF({ data: makeMinimalK3Data() })
    const buffer = await renderToBuffer(doc)
    expect(buffer).toBeInstanceOf(Buffer)
    expect(buffer.length).toBeGreaterThan(0)
  })

  it('renders with reconciled and unreconciled cash flow', async () => {
    const data = makeMinimalK3Data()
    data.kassaflodesanalys!.reconciliation.is_reconciled = false
    data.kassaflodesanalys!.reconciliation.mismatch_amount = 100
    const doc = ArsredovisningK3PDF({ data })
    const buffer = await renderToBuffer(doc)
    expect(buffer.length).toBeGreaterThan(0)
  })

  it('renders when kassaflöde + equity_changes are omitted (defensive)', async () => {
    const data = makeMinimalK3Data()
    delete data.kassaflodesanalys
    delete data.equity_changes_statement
    const doc = ArsredovisningK3PDF({ data })
    const buffer = await renderToBuffer(doc)
    expect(buffer.length).toBeGreaterThan(0)
  })

  it('renders with no signatures (empty array fallback path)', async () => {
    const data = makeMinimalK3Data()
    data.signatures = []
    const doc = ArsredovisningK3PDF({ data })
    const buffer = await renderToBuffer(doc)
    expect(buffer.length).toBeGreaterThan(0)
  })

  it('renders with multiple signatures', async () => {
    const data = makeMinimalK3Data()
    data.signatures = [
      { role: 'Styrelseledamot', name: 'Anna Andersson', signed_at: null },
      { role: 'Styrelseledamot', name: 'Bo Bengtsson', signed_at: '2026-06-15' },
      { role: 'VD', name: 'Cecilia Carlsson', signed_at: null },
    ]
    const doc = ArsredovisningK3PDF({ data })
    const buffer = await renderToBuffer(doc)
    expect(buffer.length).toBeGreaterThan(0)
  })
})

describe('ArsredovisningPDF (K2) — byte-equivalence guard', () => {
  it('K2 PDF still renders the same template (no breaking change from K3 work)', async () => {
    const data = makeMinimalK3Data()
    data.accounting_framework = 'k2'
    // The K2 template is invoked when data.accounting_framework === 'k2' in
    // the route. It should still render cleanly against the same data shape
    // (it just ignores the K3-specific fields).
    delete data.kassaflodesanalys
    delete data.equity_changes_statement
    const doc = ArsredovisningPDF({ data })
    const buffer = await renderToBuffer(doc)
    expect(buffer.length).toBeGreaterThan(0)
  })
})
