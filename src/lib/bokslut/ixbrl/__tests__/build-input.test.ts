/**
 * buildIxbrlInput with a comparison year that was never closed in the books
 * (crm#1080). The iXBRL document repeats the comparison year's equity three
 * times: the balance sheet's jämförelsekolumn, the opening row of
 * "Förändringar i eget kapital", and the movement rows derived from it. All
 * three read the one K2 mapping, so the derived Årets resultat has to reach
 * each of them, and the duplicated facts must stay value-identical
 * (TA §2.7.3).
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/reports/trial-balance', () => ({
  generateTrialBalance: vi.fn(),
}))
vi.mock('@/lib/bokslut/arsredovisning/narrative-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bokslut/arsredovisning/narrative-service')>()),
  getMedelantalOverride: vi.fn().mockResolvedValue(null),
}))

import { buildIxbrlInput } from '../build-input'
import { generateK2IxbrlDocument } from '../document/k2-document'
import { runPreflightChecks } from '../validate/rules'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import type { ArsredovisningData } from '@/lib/bokslut/arsredovisning/types'
import type { TrialBalancePair } from '../k2-mapper'
import { CURRENT, PREVIOUS } from './fixtures'

const PERIODS = [
  { id: 'fp1', name: '2025', period_start: '2025-01-01', period_end: '2025-12-31', previous_period_id: 'fp0' },
  { id: 'fp0', name: '2024', period_start: '2024-01-01', period_end: '2024-12-31', previous_period_id: null },
]

function makeSupabase() {
  return {
    from: (table: string) => {
      if (table !== 'fiscal_periods') {
        // employees: one filter, awaited directly.
        return { select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) }
      }
      return {
        select: () => ({
          eq: (_column: string, value: string) => ({
            eq: () => ({
              single: () => Promise.resolve({ data: PERIODS.find((p) => p.id === value), error: null }),
              maybeSingle: () =>
                Promise.resolve({ data: PERIODS.find((p) => p.id === value), error: null }),
            }),
            order: () => Promise.resolve({ data: PERIODS, error: null }),
          }),
        }),
      }
    },
  }
}

/** Only what buildIxbrlInput reads from the PDF model. */
const REPORT = {
  company: { name: 'Testbolaget AB', org_number: '556999-9997', registered_office: 'Sundsvall' },
  accounting_framework: 'k2',
  forvaltningsberattelse: {
    description: 'Bolaget bedriver konsultverksamhet. Bolaget har sitt säte i Sundsvall.',
    important_events: 'Inga väsentliga händelser har inträffat under räkenskapsåret.',
    flerarsoversikt: [],
    resultatdisposition: 'Styrelsen föreslår att årets resultat balanseras i ny räkning.',
    proposed_dividend: 0,
    resultatdisposition_amounts: {
      retained_earnings: 100_000,
      share_premium_reserve: 0,
      current_year_result: 120_000,
      total: 220_000,
      proposed_dividend: 0,
      carried_forward: 220_000,
    },
    agm_date: '2026-03-15',
    agm_disposition_outcome: 'proposal_approved',
    agm_disposition_decision: null,
  },
  noter: [],
  disclosures: { medelantal_anstallda_override: null },
  warnings: [],
} as unknown as ArsredovisningData

async function build(previous: TrialBalancePair) {
  vi.mocked(generateTrialBalance).mockImplementation(async (_client, _companyId, periodId, opts) => {
    const pair = periodId === 'fp0' ? previous : CURRENT
    const rows = opts.closingEntry === 'include' ? pair.full : pair.preClosing
    return { rows: rows as never, totalDebit: 0, totalCredit: 0, isBalanced: true }
  })
  return buildIxbrlInput(makeSupabase() as never, 'co1', 'fp1', {
    reportData: REPORT,
    signatureRequests: [],
    todayIso: '2026-03-20',
  })
}

function fact(xhtml: string, name: string, contextRef: string): string[] {
  const values: string[] = []
  for (const match of xhtml.matchAll(/<ix:nonFraction ([^>]*)>([^<]*)<\/ix:nonFraction>/g)) {
    if (!match[1].includes(`name="se-gen-base:${name}"`)) continue
    if (!match[1].includes(`contextRef="${contextRef}"`)) continue
    values.push(`${/sign="-"/.test(match[1]) ? '-' : ''}${match[2].replace(/\s/g, '')}`)
  }
  return values
}

describe('buildIxbrlInput: comparison year never closed in the books (crm#1080)', () => {
  const NEVER_CLOSED = { full: PREVIOUS.preClosing, preClosing: PREVIOUS.preClosing }
  const NOTICE =
    'Jämförelseåret avslutades aldrig i bokföringen: årets resultat (40000 kr) står kvar på resultatkontona. Årets resultat i jämförelseårets balansräkning är därför hämtat från resultaträkningen. Stäm av jämförelsetalen mot föregående års fastställda årsredovisning.'

  it('builds the same statements and equity roll-forward as for the year closed in the books', async () => {
    const derived = await build(NEVER_CLOSED)
    const closed = await build(PREVIOUS)

    expect(derived.br).toEqual(closed.br)
    expect(derived.rr).toEqual(closed.rr)
    expect(derived.totals).toEqual(closed.totals)
    // Opening row = the comparison year's closing equity; the 40 000 kr result
    // is then balanced in ny räkning. Read as booked the result was 0 kr and
    // the 40 000 kr showed up as an untagged "Övrig förändring".
    expect(derived.forvaltningsberattelse.egetKapital).toEqual(closed.forvaltningsberattelse.egetKapital)
    expect(derived.forvaltningsberattelse.egetKapital).toMatchObject({
      aretsResultat: { ib: 40_000, ub: 120_000 },
      balanseratResultat: { ib: 60_000, ub: 100_000 },
      totalt: { ib: 125_000, ub: 245_000 },
      balanserasINyRakning: 40_000,
      utdelning: 0,
      ovrigForandringBalanserat: 0,
    })
    expect(derived.warnings.filter((w) => w.includes('ämförelse'))).toEqual([NOTICE])
    expect(closed.warnings.filter((w) => w.includes('ämförelse'))).toEqual([])
  })

  it('tags the derived figures in the comparison contexts, each duplicate with one value', async () => {
    const { xhtml } = generateK2IxbrlDocument(await build(NEVER_CLOSED))

    // Balance sheet column and the opening row of the equity table.
    expect(new Set(fact(xhtml, 'AretsResultatEgetKapital', 'balans1'))).toEqual(new Set(['40000']))
    expect(new Set(fact(xhtml, 'EgetKapital', 'balans1'))).toEqual(new Set(['125000']))
    expect(fact(xhtml, 'Tillgangar', 'balans1')).toEqual(['253000'])
    expect(fact(xhtml, 'EgetKapitalSkulder', 'balans1')).toEqual(['253000'])
    expect(fact(xhtml, 'AretsResultat', 'period1')).toEqual(['40000'])
    expect(
      fact(xhtml, 'ForandringEgetKapitalBalanseratResultatBalanserasNyRakning', 'period0'),
    ).toEqual(['40000'])
    expect(xhtml).not.toContain('Övrig förändring')
  })

  it('carries the notice into the preflight as a warning, never as an error', async () => {
    const preflight = runPreflightChecks(await build(NEVER_CLOSED), '2026-03-20')
    expect(preflight.warnings).toContainEqual({ code: 'ACC-WARN', severity: 'warn', message: NOTICE })
    expect(preflight.errors.map((issue) => issue.code)).not.toEqual(
      expect.arrayContaining(['3005', 'ACC-2099']),
    )
  })
})
