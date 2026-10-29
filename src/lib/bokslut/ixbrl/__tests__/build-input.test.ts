/**
 * buildIxbrlInput with a comparison year that was never closed in the books
 * (crm#1080). The iXBRL document repeats the comparison year's equity three
 * times: the balance sheet's jämförelsekolumn, the opening row of
 * "Förändringar i eget kapital", and the movement rows derived from it. All
 * three read the one K2 mapping, so the derived Årets resultat has to reach
 * each of them, and the duplicated facts must stay value-identical
 * (TA §2.7.3).
 */
import { emptyAnnualReportProfile } from '@/lib/bokslut/arsredovisning/compliance-types'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/bokslut/arsredovisning/narrative-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bokslut/arsredovisning/narrative-service')>()),
  getMedelantalOverride: vi.fn().mockResolvedValue(null),
}))

import { buildIxbrlInput } from '../build-input'
import { generateK2IxbrlDocument } from '../document/k2-document'
import { generateIxbrlDocument } from '../document/generate'
import { K3_IXBRL_DISABLED_MESSAGE } from '../taxonomy/entry-points'
import { runPreflightChecks } from '../validate/rules'
import type { ArsredovisningData } from '@/lib/bokslut/arsredovisning/types'
import { mapTrialBalancesToK2, type K2MappingResult, type TrialBalancePair, type TrialBalanceRowLike } from '../k2-mapper'
import { CURRENT, PREVIOUS } from './fixtures'
import {
  buildEquitySpecification,
  k2EquityPosts,
  type EquityEntry,
} from '@/lib/bokslut/arsredovisning/equity-specification'

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

/** A year's full trial balance with the equity it opened on (credit), as generateTrialBalance answers it. */
function withOpening(rows: TrialBalanceRowLike[], opening: Record<string, number>) {
  return rows.map((row) => ({
    ...row,
    opening_debit: 0,
    opening_credit: opening[row.account_number] ?? 0,
  }))
}

function entry(id: string, date: string, lines: Array<[string, number, number]>): EquityEntry {
  return {
    id,
    voucher: id,
    entry_date: date,
    description: null,
    source_type: null,
    reverses_id: null,
    lines: lines.map(([account_number, debit, credit]) => ({ account_number, debit, credit })),
  }
}

/**
 * The report's equity specification, as buildArsredovisningReport builds it:
 * 2025 opened with the 2024 result on 2099, balanced it to 2091 and closed
 * 120 000 kr; 2024 closed 40 000 kr, unless it was never closed in the books.
 */
function equitySpecification(previous: TrialBalancePair, mapping: K2MappingResult) {
  const closed = previous.full.some((row) => row.account_number === '2099')
  return buildEquitySpecification({
    posts: k2EquityPosts('aktiebolag'),
    current: {
      fiscal_period_id: 'fp1',
      name: '2025',
      period_start: '2025-01-01',
      period_end: '2025-12-31',
      tbRows: withOpening(CURRENT.full, { '2081': 25_000, '2091': 60_000, '2099': 40_000 }),
      entries: [
        entry('je-disp', '2025-01-01', [['2099', 40_000, 0], ['2091', 0, 40_000]]),
        entry('je-close', '2025-12-31', [['8999', 120_000, 0], ['2099', 0, 120_000]]),
      ],
    },
    previous: {
      fiscal_period_id: 'fp0',
      name: '2024',
      period_start: '2024-01-01',
      period_end: '2024-12-31',
      tbRows: withOpening(previous.full, { '2081': 25_000, '2091': 60_000 }),
      entries: closed ? [entry('je-close-2024', '2024-12-31', [['8999', 40_000, 0], ['2099', 0, 40_000]])] : [],
    },
    balanceSheet: mapping,
  })
}

/** The report's statements: the two years mapped as buildArsredovisningReport maps them. */
async function build(previous: TrialBalancePair) {
  const mapping = mapTrialBalancesToK2(CURRENT, previous)
  return buildIxbrlInput(makeSupabase() as never, 'co1', 'fp1', {
    report: {
      data: { ...REPORT, equity_specification: equitySpecification(previous, mapping) },
      statements: {
        mapping,
        comparison: { id: 'fp0', period_start: '2024-01-01', period_end: '2024-12-31', loaded: true },
      },
    },
    signatureRequests: [],
    profile: emptyAnnualReportProfile('co1', 'fp1'),
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

describe('buildIxbrlInput: a K3 year', () => {
  afterEach(() => vi.unstubAllEnvs())

  const K3_REPORT = { ...REPORT, accounting_framework: 'k3' } as unknown as ArsredovisningData

  async function buildK3(data: ArsredovisningData, presentation?: 'k3') {
    const mapping = mapTrialBalancesToK2(CURRENT, PREVIOUS)
    // What P1's toK3Presentation marks a K3 mapping with.
    if (presentation) Object.assign(mapping, { presentation })
    return buildIxbrlInput(makeSupabase() as never, 'co1', 'fp1', {
      report: {
        // Every report carries the equity specification from the ledger
        // (buildArsredovisningReport), K2 or K3.
        data: { ...data, equity_specification: equitySpecification(PREVIOUS, mapping) },
        statements: {
          mapping,
          comparison: { id: 'fp0', period_start: '2024-01-01', period_end: '2024-12-31', loaded: true },
        },
      },
      signatureRequests: [],
      profile: emptyAnnualReportProfile('co1', 'fp1'),
      todayIso: '2026-03-20',
    })
  }

  it('stops with the K3 message while the K3 document is switched off', async () => {
    vi.stubEnv('NEXT_PUBLIC_K3_IXBRL_ENABLED', '')
    await expect(buildK3(K3_REPORT)).rejects.toThrow(K3_IXBRL_DISABLED_MESSAGE)
  })

  it('builds a previewable K3 input from a K2 mapping, which preflight refuses to file', async () => {
    vi.stubEnv('NEXT_PUBLIC_K3_ARSREDOVISNING_ENABLED', 'true')
    vi.stubEnv('NEXT_PUBLIC_K3_IXBRL_ENABLED', 'true')
    const input = await buildK3(K3_REPORT)
    expect(input.entryPointId).toBe('k3-ab-risbs-2021-10-31')
    expect(input.k3).toMatchObject({ forvaltningsberattelse: [], cashFlow: null, balanceSheetSource: 'k2_mapping' })
    expect(input.k3?.equity.source).toBe('ledger')
    const codes = runPreflightChecks(input, '2026-03-20').errors.map((issue) => issue.code)
    expect(codes).toEqual(expect.arrayContaining(['ACC-K3-POSTS-SOURCE']))
    expect(generateIxbrlDocument(input).xhtml).toContain('gaap/k3/risbs/2021-10-31')
  })

  it('takes the equity specification, chapter 7 statement, K3 items and K3 posts when the report has them', async () => {
    vi.stubEnv('NEXT_PUBLIC_K3_ARSREDOVISNING_ENABLED', 'true')
    vi.stubEnv('NEXT_PUBLIC_K3_IXBRL_ENABLED', 'true')
    const data = {
      ...K3_REPORT,
      kassaflodesanalys: {
        statement: { current: { amounts: { likvida_medel_ib: 185_000, likvida_medel_ub: 270_000 }, reconciliation: { is_reconciled: true } }, previous: null },
      },
      k3_forvaltningsberattelse: [{ concept: 'UppgiftAgareMerAnTioProcentAndelarRoster', heading: 'Ägarförhållanden', text: 'Ägs av Moder AB.' }],
    } as unknown as ArsredovisningData
    const input = await buildK3(data, 'k3')
    expect(input.k3?.equity.source).toBe('ledger')
    expect(input.k3?.cashFlow?.source).toBe('chapter7')
    expect(input.k3?.balanceSheetSource).toBe('k3_presentation')
    expect(input.k3?.forvaltningsberattelse).toHaveLength(1)
    const codes = runPreflightChecks(input, '2026-03-20').errors.map((issue) => issue.code)
    expect(codes.filter((code) => code.endsWith('-SOURCE'))).toEqual([])
  })

  it('leaves a K2 year without a K3 part', async () => {
    vi.stubEnv('NEXT_PUBLIC_K3_ARSREDOVISNING_ENABLED', 'true')
    vi.stubEnv('NEXT_PUBLIC_K3_IXBRL_ENABLED', 'true')
    const input = await build(PREVIOUS)
    expect(input.entryPointId).toBe('k2-ab-risbs-2024-09-12')
    expect('k3' in input).toBe(false)
  })
})
