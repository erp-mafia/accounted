/**
 * ÅRL post-level statement rows for the årsredovisning PDF.
 *
 * The regression that matters most here: NO label may carry a BAS account
 * number. A user filed an årsredovisning whose RR/BR listed per-account rows
 * ("1930 Företagskonto", "3001 Försäljning …") and Bolagsverket rejected it
 * with "Balansräkning och resultaträkning ska inte innehålla kontonummer".
 * The rows must be the statutory posts from the K2 risbs mapping - the same
 * mapping the iXBRL filing uses - so PDF and digital filing cannot diverge.
 */
import { describe, it, expect } from 'vitest'
import {
  mapTrialBalancesToK2,
  type TrialBalanceRowLike,
  type TrialBalancePair,
} from '@/lib/bokslut/ixbrl/k2-mapper'
import {
  K2_BALANSRAKNING_EGET_KAPITAL_SKULDER,
  K2_BALANSRAKNING_TILLGANGAR,
  K2_RESULTATRAKNING,
  K3_BALANSRAKNING_EGET_KAPITAL_SKULDER,
  K3_BALANSRAKNING_TILLGANGAR,
  K3_RESULTATRAKNING,
  renderStatementRows,
  type StatementNode,
} from '@/lib/bokslut/ixbrl/document/statements'
import type { FactWriter } from '@/lib/bokslut/ixbrl/document/ix'
import { K2_BR_MAPPINGS, K2_RR_MAPPINGS } from '@/lib/bokslut/ixbrl/k2-mapper'
import { k3ConceptAmounts } from '@/lib/bokslut/ixbrl/k3-adapters'
import type { ConceptAmounts } from '@/lib/bokslut/ixbrl/types'
import { toK3Presentation } from '../k3-presentation'
import { buildRrRows, buildBrRows } from '../statement-rows'

function tbRow(
  account: string,
  name: string,
  opts: { debit?: number; credit?: number },
): TrialBalanceRowLike {
  return {
    account_number: account,
    account_name: name,
    closing_debit: opts.debit ?? 0,
    closing_credit: opts.credit ?? 0,
  }
}

/**
 * Balanced fixture year: 600 000 bank = 50 000 aktiekapital + 250 000
 * balanserat + 300 000 årets resultat. RR: 520 600 omsättning − 200 000
 * kostnader − 20 600 skatt = 300 000.
 */
function currentPair(): TrialBalancePair {
  const full = [
    tbRow('1930', 'Företagskonto', { debit: 600_000 }),
    tbRow('2081', 'Aktiekapital', { credit: 50_000 }),
    tbRow('2091', 'Balanserad vinst', { credit: 250_000 }),
    tbRow('2099', 'Årets resultat', { credit: 300_000 }),
  ]
  const preClosing = [
    ...full.filter((r) => r.account_number !== '2099'),
    tbRow('3001', 'Försäljning varor 25%', { credit: 520_600 }),
    tbRow('4310', 'Inköp av råvaror och material', { debit: 200_000 }),
    tbRow('8910', 'Skatt på årets resultat', { debit: 20_600 }),
  ]
  return { full, preClosing }
}

function previousPair(): TrialBalancePair {
  const full = [
    tbRow('1930', 'Företagskonto', { debit: 300_000 }),
    tbRow('2081', 'Aktiekapital', { credit: 50_000 }),
    tbRow('2091', 'Balanserad vinst', { credit: 100_000 }),
    tbRow('2099', 'Årets resultat', { credit: 150_000 }),
  ]
  const preClosing = [
    ...full.filter((r) => r.account_number !== '2099'),
    tbRow('3001', 'Försäljning varor 25%', { credit: 250_000 }),
    tbRow('4310', 'Inköp av råvaror och material', { debit: 100_000 }),
  ]
  return { full, preClosing }
}

function reportedAccountsPair(): TrialBalancePair {
  const full = [
    tbRow('1250', 'Computers', { debit: 50 }),
    tbRow('1259', 'Accumulated depreciation', { credit: 10 }),
    tbRow('1930', 'Bank', { debit: 75 }),
    tbRow('2081', 'Share capital', { credit: 50 }),
    tbRow('2099', 'Current-year result', { credit: 90 }),
    tbRow('2650', 'VAT settlement account', { debit: 25 }),
  ]
  const preClosing = [
    ...full.filter((row) => row.account_number !== '2099'),
    tbRow('3010', 'Revenue', { credit: 100 }),
    tbRow('7833', 'Depreciation of computers', { debit: 10 }),
  ]
  return { full, preClosing }
}

describe('buildRrRows / buildBrRows — no kontonummer regression', () => {
  it('no RR or BR label contains a BAS account number', () => {
    const mapping = mapTrialBalancesToK2(currentPair(), previousPair())
    const rr = buildRrRows(mapping)
    const { assets, equityLiabilities } = buildBrRows(mapping)
    for (const row of [...rr, ...assets, ...equityLiabilities]) {
      // Catches both "1930 Företagskonto" prefixes and any stray 4-digit
      // account reference inside a label.
      expect(row.label).not.toMatch(/\d{4}/)
    }
  })
})

describe('buildRrRows', () => {
  it('renders account 7833 depreciation in the statutory expense post', () => {
    const rows = buildRrRows(mapTrialBalancesToK2(reportedAccountsPair(), null))

    expect(
      rows.find(
        (row) =>
          row.label === 'Av- och nedskrivningar av materiella och immateriella anläggningstillgångar',
      )?.current,
    ).toBe(-10)
  })

  it('follows the ÅRL uppställningsform order with posts and subtotals', () => {
    const mapping = mapTrialBalancesToK2(currentPair(), null)
    const labels = buildRrRows(mapping).map((r) => r.label)
    const order = [
      'Rörelseintäkter, lagerförändringar m.m.',
      'Nettoomsättning',
      'Summa rörelseintäkter, lagerförändringar m.m.',
      'Rörelsekostnader',
      'Råvaror och förnödenheter',
      'Summa rörelsekostnader',
      'Rörelseresultat',
      'Summa finansiella poster',
      'Resultat efter finansiella poster',
      'Resultat före skatt',
      'Skatt på årets resultat',
      'Årets resultat',
    ]
    const indices = order.map((label) => labels.indexOf(label))
    expect(indices).not.toContain(-1)
    expect([...indices].sort((a, b) => a - b)).toEqual(indices)
  })

  it('shows cost posts with a presentational minus', () => {
    const mapping = mapTrialBalancesToK2(currentPair(), null)
    const rr = buildRrRows(mapping)
    expect(rr.find((r) => r.label === 'Råvaror och förnödenheter')?.current).toBe(-200_000)
    expect(rr.find((r) => r.label === 'Skatt på årets resultat')?.current).toBe(-20_600)
    expect(rr.find((r) => r.label === 'Summa rörelsekostnader')?.current).toBe(-200_000)
  })

  it('skips zero posts but keeps Nettoomsättning and all subtotals', () => {
    const mapping = mapTrialBalancesToK2(currentPair(), null)
    const labels = buildRrRows(mapping).map((r) => r.label)
    expect(labels).not.toContain('Handelsvaror')
    expect(labels).not.toContain('Övriga rörelseintäkter')
    expect(labels).toContain('Nettoomsättning')
    expect(labels).toContain('Summa finansiella poster')
  })

  it('omits the Bokslutsdispositioner section when no dispositions are booked', () => {
    const mapping = mapTrialBalancesToK2(currentPair(), null)
    const labels = buildRrRows(mapping).map((r) => r.label)
    expect(labels).not.toContain('Bokslutsdispositioner')
    expect(labels).not.toContain('Summa bokslutsdispositioner')
  })

  it('ties Årets resultat to the mapping total and the booked 2099', () => {
    const mapping = mapTrialBalancesToK2(currentPair(), null)
    const rr = buildRrRows(mapping)
    const aretsResultat = rr[rr.length - 1]
    expect(aretsResultat.label).toBe('Årets resultat')
    expect(aretsResultat.semantic_key).toBe('income_statement_result')
    expect(aretsResultat.is_total).toBe(true)
    expect(aretsResultat.current).toBe(mapping.totals.aretsResultat.current)
    expect(aretsResultat.current).toBe(300_000)
  })

  it('fills the jämförelseår column when a previous year exists, null otherwise', () => {
    const withPrev = buildRrRows(mapTrialBalancesToK2(currentPair(), previousPair()))
    expect(withPrev.find((r) => r.label === 'Nettoomsättning')?.previous).toBe(250_000)
    expect(withPrev.find((r) => r.label === 'Årets resultat')?.previous).toBe(150_000)

    const firstYear = buildRrRows(mapTrialBalancesToK2(currentPair(), null))
    expect(firstYear.find((r) => r.label === 'Nettoomsättning')?.previous).toBeNull()
  })
})

describe('buildBrRows', () => {
  it('renders a debit on account 2650 under receivables instead of liabilities', () => {
    const { assets, equityLiabilities } = buildBrRows(
      mapTrialBalancesToK2(reportedAccountsPair(), null),
    )

    expect(assets.find((row) => row.label === 'Övriga fordringar')?.current).toBe(25)
    expect(equityLiabilities.find((row) => row.label === 'Övriga skulder')?.current).toBe(0)
    expect(assets.at(-1)?.current).toBe(140)
    expect(equityLiabilities.at(-1)?.current).toBe(140)
  })

  it('renders Kassa och bank as a post and ends both sides on tied totals', () => {
    const mapping = mapTrialBalancesToK2(currentPair(), null)
    const { assets, equityLiabilities } = buildBrRows(mapping)

    expect(
      equityLiabilities.find((row) => row.semantic_key === 'balance_sheet_current_year_result'),
    ).toMatchObject({ label: 'Årets resultat', current: 300_000 })

    expect(assets.find((r) => r.label === 'Kassa och bank' && !r.is_heading)?.current).toBe(
      600_000,
    )
    const totalAssets = assets[assets.length - 1]
    expect(totalAssets.label).toBe('Summa tillgångar')
    expect(totalAssets.current).toBe(600_000)

    const totalEqLiab = equityLiabilities[equityLiabilities.length - 1]
    expect(totalEqLiab.label).toBe('Summa eget kapital och skulder')
    expect(totalEqLiab.current).toBe(600_000)
    expect(totalEqLiab.current).toBe(totalAssets.current)
  })

  it('omits zero subsections (varulager, obeskattade reserver, långfristiga skulder)', () => {
    const mapping = mapTrialBalancesToK2(currentPair(), null)
    const { assets, equityLiabilities } = buildBrRows(mapping)
    const labels = [...assets, ...equityLiabilities].map((r) => r.label)
    expect(labels).not.toContain('Varulager m.m.')
    expect(labels).not.toContain('Obeskattade reserver')
    expect(labels).not.toContain('Långfristiga skulder')
  })

  it('keeps statutory always-visible posts even at zero', () => {
    const mapping = mapTrialBalancesToK2(currentPair(), null)
    const { assets, equityLiabilities } = buildBrRows(mapping)
    expect(assets.some((r) => r.label === 'Övriga fordringar')).toBe(true)
    expect(equityLiabilities.some((r) => r.label === 'Leverantörsskulder')).toBe(true)
    expect(equityLiabilities.some((r) => r.label === 'Balanserat resultat')).toBe(true)
  })

  it('maps equity to Bundet/Fritt posts with previous-year figures', () => {
    const mapping = mapTrialBalancesToK2(currentPair(), previousPair())
    const { equityLiabilities } = buildBrRows(mapping)
    const aktiekapital = equityLiabilities.find((r) => r.label === 'Aktiekapital')
    expect(aktiekapital?.current).toBe(50_000)
    expect(aktiekapital?.previous).toBe(50_000)
    const balanserat = equityLiabilities.find((r) => r.label === 'Balanserat resultat')
    expect(balanserat?.current).toBe(250_000)
    expect(balanserat?.previous).toBe(100_000)
    const summaEk = equityLiabilities.find((r) => r.label === 'Summa eget kapital')
    expect(summaEk?.current).toBe(600_000)
    expect(summaEk?.previous).toBe(300_000)
  })

  it('keys the registered aktiekapital and the equity total for the kontrollbalans check', () => {
    // completeness.ts compares them (ABL 25 kap. 13 §) without reading labels.
    const mapping = mapTrialBalancesToK2(currentPair(), null)
    const { equityLiabilities } = buildBrRows(mapping)
    const byKey = (key: string) => equityLiabilities.filter((r) => r.semantic_key === key)
    expect(byKey('balance_sheet_share_capital')).toEqual([
      expect.objectContaining({ label: 'Aktiekapital', current: 50_000 }),
    ])
    expect(byKey('balance_sheet_equity_total')).toEqual([
      expect.objectContaining({ label: 'Summa eget kapital', current: 600_000, is_total: true }),
    ])
  })

  it('produces no mapper warnings for the balanced fixture', () => {
    const mapping = mapTrialBalancesToK2(currentPair(), previousPair())
    expect(mapping.warnings).toEqual([])
  })

  it('prints the same jämförelseår column whether or not that year was closed in the books (crm#1080)', () => {
    // The comparison year with its 150 000 kr result still on the result
    // accounts and nothing on 2099. The rows are what the PDF and the preview
    // print, so they must match the closed year row for row.
    const neverClosed = { full: previousPair().preClosing, preClosing: previousPair().preClosing }
    const derived = buildBrRows(mapTrialBalancesToK2(currentPair(), neverClosed))
    const closed = buildBrRows(mapTrialBalancesToK2(currentPair(), previousPair()))
    expect(derived).toEqual(closed)

    const byKey = (key: string) =>
      derived.equityLiabilities.find((r) => r.semantic_key === key)?.previous
    expect(byKey('balance_sheet_current_year_result')).toBe(150_000)
    expect(byKey('balance_sheet_equity_total')).toBe(300_000)
    expect(derived.equityLiabilities.at(-1)).toMatchObject({
      label: 'Summa eget kapital och skulder',
      previous: 300_000,
    })
    expect(derived.assets.at(-1)).toMatchObject({ label: 'Summa tillgångar', previous: 300_000 })
  })
})

describe('one row list for the PDF and the filing', () => {
  /** A year with every post of the mapper non-zero, and K3's own accounts. */
  function everyPost(): TrialBalancePair {
    const row = (account: string, balance: 'debit' | 'credit', amount: number) =>
      tbRow(account, account, balance === 'debit' ? { debit: amount } : { credit: amount })
    const full = K2_BR_MAPPINGS.map((m, index) => row(m.ranges[0].start, m.balance, 1_000 + index * 10))
    const preClosing = K2_RR_MAPPINGS.map((m, index) => row(m.ranges[0].start, m.balance, 2_000 + index * 10))
    full.push(
      row('1010', 'debit', 500),
      row('1370', 'debit', 600),
      row('1640', 'debit', 700),
      row('2089', 'credit', 800),
      row('2096', 'credit', 900),
      row('2240', 'credit', 950),
      row('2250', 'credit', 970),
    )
    return { full, preClosing }
  }

  /** What the iXBRL document prints: each row's label and its amounts, in order. */
  function filedRows(nodes: readonly StatementNode[], amounts: ConceptAmounts, totals: Parameters<typeof renderStatementRows>[3]) {
    const writer = {
      money: (_concept: string, _context: string, value: number, options?: { displayMinus?: boolean }) =>
        `@${options?.displayMinus ? -value : value}@`,
    } as unknown as FactWriter
    return renderStatementRows(writer, nodes, amounts, totals, { current: 'c', previous: 'p' }).map((html) => [
      (/<th[^>]*>(.*?)<\/th>/.exec(html)?.[1] ?? '').replace(/&amp;/g, '&'),
      [...html.matchAll(/@(-?[0-9.]+)@/g)].map((match) => Number(match[1]))[0] ?? null,
    ])
  }

  const printed = (rows: ReturnType<typeof buildRrRows>) => rows.map((row) => [row.label, row.current === null ? null : row.current + 0])

  it('K2: the same posts, labels, order and amounts', () => {
    const pair = everyPost()
    const k2 = mapTrialBalancesToK2(pair, pair)
    const balance = buildBrRows(k2)
    expect(printed(buildRrRows(k2))).toEqual(filedRows(K2_RESULTATRAKNING, k2.rr, k2.totals))
    expect(printed(balance.assets)).toEqual(filedRows(K2_BALANSRAKNING_TILLGANGAR, k2.br, k2.totals))
    expect(printed(balance.equityLiabilities)).toEqual(filedRows(K2_BALANSRAKNING_EGET_KAPITAL_SKULDER, k2.br, k2.totals))
  })

  it('K3: the same posts, labels, order and amounts, the taxonomy\'s own', () => {
    const pair = everyPost()
    const k3 = toK3Presentation(mapTrialBalancesToK2(pair, pair), pair.full, pair.full)
    const named = k3ConceptAmounts(k3.rr, k3.br)
    const balance = buildBrRows(k3)
    expect(printed(buildRrRows(k3))).toEqual(filedRows(K3_RESULTATRAKNING, named.rr, k3.totals))
    expect(printed(balance.assets)).toEqual(filedRows(K3_BALANSRAKNING_TILLGANGAR, named.br, k3.totals))
    expect(printed(balance.equityLiabilities)).toEqual(filedRows(K3_BALANSRAKNING_EGET_KAPITAL_SKULDER, named.br, k3.totals))
  })

  it('hides what the filing hides: a post with nothing in either year, a group whose total is zero', () => {
    const pair = currentPair()
    const k2 = mapTrialBalancesToK2(pair, null)
    const balance = buildBrRows(k2)
    expect(printed(balance.assets)).toEqual(filedRows(K2_BALANSRAKNING_TILLGANGAR, k2.br, k2.totals))
    expect(balance.assets.map((row) => row.label)).not.toContain('Varulager m.m.')
  })
})
