/**
 * crm#1171 / crm#1172: the draft PDF printed empty signature rows and a
 * fastställelseintyg full of blanks, as if the draft were a form to fill in
 * by hand. A draft now explains those pages; only a version locked for
 * signature keeps the blank lines. These tests read the text the rendered
 * file actually carries.
 */
import { describe, it, expect } from 'vitest'
import { renderToBuffer } from '@react-pdf/renderer'
import { ArsredovisningPDF } from '../arsredovisning-pdf'
import { ArsredovisningK3PDF } from '../arsredovisning-k3-pdf'
import {
  CERTIFICATE_SIGNER,
  draftCertificateNote,
  pdfModeForVersionStatus,
  signatureDate,
} from '../signature-pages'
import { CERTIFICATE_SIGNER_ROLES, VersionCreateSchema } from '../workflow-schemas'
import type { ArsredovisningData } from '../types'
import { pdfTextStrings } from '@/tests/pdf-text'

const RENDER_TIMEOUT = 30_000

function makeData(overrides: {
  framework?: 'k2' | 'k3'
  entityType?: string
  signatures?: ArsredovisningData['signatures']
  agmDate?: string | null
  agmOutcome?: ArsredovisningData['forvaltningsberattelse']['agm_disposition_outcome']
} = {}): ArsredovisningData {
  return {
    company: {
      name: 'Testbolaget AB',
      org_number: '556677-8899',
      entity_type: overrides.entityType ?? 'aktiebolag',
      registered_office: 'Stockholm',
    },
    fiscal_period: { id: 'fp1', name: '2025', period_start: '2025-01-01', period_end: '2025-12-31' },
    previous_period: null,
    accounting_framework: overrides.framework ?? 'k2',
    forvaltningsberattelse: {
      description: 'Bolaget bedriver konsultverksamhet.',
      important_events: 'Inga väsentliga händelser.',
      kontrollbalans_required: false,
      flerarsoversikt: [{ year: '2025', net_revenue: 100_000, result_after_financial: 10_000, soliditet_pct: 50 }],
      egen_kapital_changes: [{ label: 'Summa eget kapital', amount: 35_000 }],
      resultatdisposition: 'Styrelsen föreslår att årets resultat balanseras i ny räkning.',
      proposed_dividend: 0,
      resultatdisposition_amounts: {
        retained_earnings: 0,
        share_premium_reserve: 0,
        current_year_result: 10_000,
        total: 10_000,
        proposed_dividend: 0,
        carried_forward: 10_000,
      },
      agm_date: overrides.agmDate ?? null,
      member_disclosures: null,
      agm_disposition_outcome: overrides.agmOutcome ?? null,
      agm_disposition_decision: null,
    },
    resultatrakning: [{ label: 'Årets resultat', current: 10_000, previous: null, is_total: true }],
    balansrakning: {
      assets: [{ label: 'Summa tillgångar', current: 35_000, previous: null, is_total: true }],
      total_assets: 35_000,
      total_assets_previous: null,
      equity_liabilities: [{ label: 'Summa eget kapital och skulder', current: 35_000, previous: null, is_total: true }],
      total_equity_liabilities: 35_000,
      total_equity_liabilities_previous: null,
    },
    noter: [{ number: 1, title: 'Redovisnings- och värderingsprinciper', body: 'Enligt BFNAR 2016:10.' }],
    signatures: overrides.signatures ?? [],
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

async function render(data: ArsredovisningData, mode?: 'draft' | 'signing'): Promise<string[]> {
  const doc =
    data.accounting_framework === 'k3' ? ArsredovisningK3PDF({ data, mode }) : ArsredovisningPDF({ data, mode })
  return pdfTextStrings(await renderToBuffer(doc))
}

function page(pages: string[], marker: string): string {
  const found = pages.filter((text) => text.includes(marker))
  expect(found.length).toBeGreaterThan(0)
  return found.join('\n')
}

const SIGNERS: ArsredovisningData['signatures'] = [
  { role: 'Styrelseledamot', name: 'Anna Andersson', signed_at: '2026-03-02T11:00:00.000Z' },
  { role: 'VD', name: 'Bo Bengtsson', signed_at: null },
]

describe('pdfModeForVersionStatus', () => {
  it('renders the live preview, versionsutkast and replaced versions as drafts', () => {
    expect(pdfModeForVersionStatus(null)).toBe('draft')
    expect(pdfModeForVersionStatus(undefined)).toBe('draft')
    expect(pdfModeForVersionStatus('draft')).toBe('draft')
    expect(pdfModeForVersionStatus('superseded')).toBe('draft')
  })

  it('renders a version locked for signature, and every later state, for signing', () => {
    for (const status of ['ready_for_signature', 'signed', 'filed', 'registered']) {
      expect(pdfModeForVersionStatus(status)).toBe('signing')
    }
  })
})

describe('signatureDate', () => {
  it('prints the calendar date of a signature', () => {
    expect(signatureDate('2026-03-02T11:00:00.000Z')).toBe('2026-03-02')
    expect(signatureDate(null)).toBeNull()
  })

  it('reads the Swedish day from the instant, not the UTC string', () => {
    // 00:02 in Stockholm on 23 October (summer time) is 22:02 UTC on the 22nd.
    expect(signatureDate('2026-10-22T22:02:16.001+00:00')).toBe('2026-10-23')
    // 00:30 in Stockholm on 2 March (winter time) is 23:30 UTC on the 1st.
    expect(signatureDate('2026-03-01T23:30:00Z')).toBe('2026-03-02')
  })

  it('passes a plain date through', () => {
    expect(signatureDate('2026-03-02')).toBe('2026-03-02')
  })
})

describe('årsredovisning PDF, draft render', () => {
  it('K2 without signers or AGM: no blank lines, a note on each page instead', async () => {
    const pages = await render(makeData())
    const all = pages.join('\n')
    expect(all).not.toContain('____')
    expect(all).toContain('(utkast)')

    const signatures = page(pages, 'Inga undertecknare')
    expect(signatures).toContain('Inga undertecknare är registrerade ännu.')
    expect(signatures).toContain('ÅRL 2 kap. 7 §')

    const certificate = page(pages, 'Fastställelseintyget fylls i efter årsstämman')
    expect(certificate).not.toContain('Undertecknad')
    expect(certificate).not.toContain('(närvarande vid')
  }, RENDER_TIMEOUT)

  it('K2 with registered signers and a recorded AGM: prints what is known, still no blanks', async () => {
    const pages = await render(
      makeData({ signatures: SIGNERS, agmDate: '2026-05-20', agmOutcome: 'proposal_approved' }),
    )
    const all = pages.join('\n')
    expect(all).not.toContain('____')
    const signatures = page(pages, 'Anna Andersson')
    expect(signatures).toContain('Bo Bengtsson')
    expect(signatures).toContain('Undertecknad 2026-03-02')
    const certificate = page(pages, 'den 2026-05-20')
    expect(certificate).toContain('beslutade att godkänna styrelsens förslag')
    // A draft is not the copy that is filed: no bestyrkande on it.
    expect(certificate).not.toContain('överensstämmer med originalet')
  }, RENDER_TIMEOUT)

  it('an ekonomisk förening is told about the föreningsstämma', async () => {
    const pages = await render(makeData({ entityType: 'ekonomisk_forening' }))
    page(pages, 'Fastställelseintyget fylls i efter föreningsstämman')
  }, RENDER_TIMEOUT)

  it('K3 drafts follow the same rule', async () => {
    const pages = await render(makeData({ framework: 'k3' }))
    const all = pages.join('\n')
    expect(all).not.toContain('____')
    page(pages, 'Inga undertecknare är registrerade ännu.')
    page(pages, 'Fastställelseintyget fylls i efter årsstämman')
  }, RENDER_TIMEOUT)
})

describe('årsredovisning PDF, signing render', () => {
  it('K2 keeps the lines the board fills in by hand, with a date per signer', async () => {
    const pages = await render(makeData({ signatures: SIGNERS }), 'signing')
    const all = pages.join('\n')
    expect(all).not.toContain('(utkast)')
    expect(all).not.toContain('Utkast.')
    const signatures = page(pages, 'Anna Andersson')
    expect(signatures).toContain('Datum: 2026-03-02')
    expect(signatures).toContain('Datum: ____________')
    const certificate = page(pages, 'Undertecknad styrelseledamot eller verkställande direktör')
    // The meeting noun and "den" used to run together ("årsstämmaden").
    expect(certificate).toContain('årsstämma den ____________________')
    // The signature line names both roles that may sign the intyg.
    expect(certificate).toContain('Styrelseledamot eller verkställande direktör')
    // The paper copy is a bestyrkt kopia (ÅRL 8 kap. 3 § p. 1).
    expect(certificate).toContain('Jag intygar att denna kopia av årsredovisningen överensstämmer med originalet.')
  }, RENDER_TIMEOUT)

  it('K3 keeps them too', async () => {
    const pages = await render(makeData({ framework: 'k3', signatures: SIGNERS }), 'signing')
    const signatures = page(pages, 'Anna Andersson')
    expect(signatures).toContain('Datum: ____________')
    const certificate = page(pages, 'Undertecknad styrelseledamot eller verkställande direktör')
    expect(certificate).toContain('överensstämmer med originalet')
  }, RENDER_TIMEOUT)
})

/**
 * Product decision 2026-10-15: a board member or the verkställande direktör
 * may sign the fastställelseintyg (swedish-financial-reporting,
 * bolagsverket-filing.md § 5; ÅRL 8 kap. 3 §).
 */
describe('who signs the fastställelseintyg', () => {
  const finalize = (role: string) =>
    VersionCreateSchema.safeParse({
      action: 'finalize',
      certificate_signer: { first_name: 'Anna', last_name: 'Andersson', role },
    })

  it('accepts a board member and the VD as certificate signer', () => {
    for (const role of ['Styrelseledamot', 'Styrelseordförande', 'VD', 'Verkställande direktör']) {
      expect(finalize(role).success).toBe(true)
    }
    expect(CERTIFICATE_SIGNER_ROLES).toEqual(
      expect.arrayContaining(['Styrelseledamot', 'VD', 'Verkställande direktör']),
    )
  })

  it('refuses a role that may not sign it', () => {
    expect(finalize('Revisor').success).toBe(false)
    // The revisor is in the roster for the påteckning, never for the intyg.
    for (const role of ['Auktoriserad revisor', 'Godkänd revisor', 'Huvudansvarig revisor']) {
      expect(finalize(role).success).toBe(false)
    }
    expect(finalize('Ekonomiansvarig').success).toBe(false)
  })

  it('names both roles in the PDF text', () => {
    expect(CERTIFICATE_SIGNER).toBe('styrelseledamot eller verkställande direktör')
    expect(draftCertificateNote('årsstämman')).toContain(`skrivs under av en ${CERTIFICATE_SIGNER}`)
  })

  it('K3 says the same', async () => {
    const pages = await render(makeData({ framework: 'k3', signatures: SIGNERS }), 'signing')
    const certificate = page(pages, 'Undertecknad styrelseledamot eller verkställande direktör')
    expect(certificate).toContain('Styrelseledamot eller verkställande direktör')
  }, RENDER_TIMEOUT)
})
