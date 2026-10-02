/**
 * The K2 balance sheet sections: one grouping shared by the årsredovisning
 * (computeTotals) and the Balansrapport (k2BrSectionForAccount).
 *
 * The characterization snapshot was written on main before the subtotal
 * lists moved into K2_BR_LAYOUT. It feeds a balance in every K2 BR range
 * through both equity tables, so any change in which post lands in which
 * subtotal, which heading prints, or how a residual is smoothed shows up as
 * a diff instead of a silently different filing.
 */
import { describe, it, expect } from 'vitest'
import {
  K2_BR_LAYOUT,
  K2_BR_MAPPINGS,
  K2_BR_MAPPINGS_EKONOMISK_FORENING,
  k2BrSectionForAccount,
  k2LegalFormFor,
  mapTrialBalancesToK2,
  type K2BrHeading,
  type K2BrSection,
  type K2LegalForm,
  type K2MappingResult,
  type TrialBalancePair,
  type TrialBalanceRowLike,
} from '../k2-mapper'
import { buildBrRows, buildRrRows } from '@/lib/bokslut/arsredovisning/statement-rows'
import { roundOre } from '@/lib/money'

function row(account: string, debit: number, credit: number): TrialBalanceRowLike {
  return { account_number: account, account_name: `Konto ${account}`, closing_debit: debit, closing_credit: credit }
}

function mappingsFor(legalForm: K2LegalForm) {
  return legalForm === 'ekonomisk_forening' ? K2_BR_MAPPINGS_EKONOMISK_FORENING : K2_BR_MAPPINGS
}

/**
 * One account at the start of every range, with öre amounts so rounding and
 * smoothing are exercised, a credit 1630 and a debit 2641 so the sign
 * reclassifications run, and 2099 balancing the sheet to the öre.
 */
function year(legalForm: K2LegalForm, scale: number): TrialBalancePair {
  const full: TrialBalanceRowLike[] = []
  let index = 0
  for (const mapping of mappingsFor(legalForm)) {
    if (mapping.concept === 'AretsResultatEgetKapital') continue
    for (const range of mapping.ranges) {
      index += 1
      const amount = roundOre((index * 1_000 + (index % 3) * 0.37) * scale)
      full.push(mapping.balance === 'debit' ? row(range.start, amount, 0) : row(range.start, 0, amount))
    }
  }
  full.push(row('1631', 0, roundOre(1_234.56 * scale)))
  full.push(row('2641', roundOre(789.12 * scale), 0))
  const net = full.reduce((sum, r) => sum + r.closing_debit - r.closing_credit, 0)
  const result = roundOre(net)
  full.push(result >= 0 ? row('2099', 0, result) : row('2099', -result, 0))

  const preClosing = full
    .filter((r) => r.account_number !== '2099')
    .concat([row('3010', 0, result + 500), row('5010', 500, 0)])
  return { full, preClosing }
}

function mapped(legalForm: K2LegalForm): K2MappingResult {
  return mapTrialBalancesToK2(year(legalForm, 1), year(legalForm, 0.9), { legalForm })
}

function statements(legalForm: K2LegalForm) {
  const mapping = mapped(legalForm)
  return {
    br: mapping.br,
    totals: mapping.totals,
    warnings: mapping.warnings,
    unmappedAccounts: mapping.unmappedAccounts,
    brRows: buildBrRows(mapping),
    rrRows: buildRrRows(mapping),
  }
}

type LayoutNode = K2BrSection | K2BrHeading

function leaves(nodes: ReadonlyArray<LayoutNode>): K2BrSection[] {
  return nodes.flatMap((node) => ('sections' in node ? [...node.sections] : [node]))
}

const LEGAL_FORMS: K2LegalForm[] = ['aktiebolag', 'ekonomisk_forening']

describe('K2 balance sheet characterization', () => {
  it('produces the same årsredovisning for both equity tables as before the layout extraction', async () => {
    const output = {
      aktiebolag: statements('aktiebolag'),
      ekonomisk_forening: statements('ekonomisk_forening'),
    }
    await expect(JSON.stringify(output, null, 2)).toMatchFileSnapshot(
      './__snapshots__/k2-br-characterization.json',
    )
  })
})

describe('K2_BR_LAYOUT', () => {
  it.each(LEGAL_FORMS)('puts every BR post of the %s table in exactly one section', (legalForm) => {
    const sectionsByConcept = new Map<string, string[]>()
    for (const leaf of leaves([...K2_BR_LAYOUT.assets, ...K2_BR_LAYOUT.equityLiabilities])) {
      for (const concept of leaf.concepts) {
        sectionsByConcept.set(concept, [...(sectionsByConcept.get(concept) ?? []), leaf.key])
      }
    }
    for (const mapping of mappingsFor(legalForm)) {
      expect(sectionsByConcept.get(mapping.concept), mapping.concept).toHaveLength(1)
    }
  })

  it.each(LEGAL_FORMS)('has no account in two posts of the %s table', (legalForm) => {
    for (let n = 1000; n <= 2999; n += 1) {
      const account = String(n)
      const matches = mappingsFor(legalForm).filter((m) =>
        m.ranges.some((range) => account >= range.start && account <= range.end),
      )
      expect(matches.length, account).toBeLessThanOrEqual(1)
    }
  })

  it.each(LEGAL_FORMS)('adds up to the årsredovisning totals heading by heading (%s)', (legalForm) => {
    const { br, totals } = mapped(legalForm)
    const totalOf = (node: LayoutNode): number =>
      node.key === 'tecknatEjInbetaltKapital'
        ? br['TecknatEjInbetaltKapital'].current
        : totals[node.key as Exclude<LayoutNode['key'], 'tecknatEjInbetaltKapital'>].current
    const sumOf = (nodes: ReadonlyArray<LayoutNode>) =>
      roundOre(nodes.reduce((sum, node) => sum + totalOf(node), 0))

    for (const node of [...K2_BR_LAYOUT.assets, ...K2_BR_LAYOUT.equityLiabilities]) {
      if ('sections' in node) expect(totalOf(node), node.key).toBe(sumOf(node.sections))
    }
    expect(totals.tillgangar.current).toBe(sumOf(K2_BR_LAYOUT.assets))
    expect(totals.egetKapitalSkulder.current).toBe(sumOf(K2_BR_LAYOUT.equityLiabilities))
  })

  it('labels its headings as the årsredovisning prints them, in the same order', () => {
    const { assets, equityLiabilities } = buildBrRows(mapped('aktiebolag'))
    const printed = (rows: typeof assets) => rows.filter((r) => r.is_heading).map((r) => r.label)
    const headings = (nodes: ReadonlyArray<LayoutNode>) =>
      nodes.flatMap((node) =>
        'sections' in node ? [node.label, ...node.sections.map((s) => s.label)] : [node.label],
      )

    // Tecknat men ej inbetalt kapital is the post above the first heading.
    expect(assets[0].label).toBe(K2_BR_LAYOUT.assets[0].label)
    expect(printed(assets)).toEqual(headings(K2_BR_LAYOUT.assets).slice(1))
    expect(printed(equityLiabilities)).toEqual(headings(K2_BR_LAYOUT.equityLiabilities))
  })
})

describe('k2BrSectionForAccount', () => {
  it.each([
    ['1070', 'immateriellaAnlaggningstillgangar'],
    ['1220', 'materiellaAnlaggningstillgangar'],
    ['1229', 'materiellaAnlaggningstillgangar'],
    ['1383', 'finansiellaAnlaggningstillgangar'],
    ['1460', 'varulager'],
    ['1510', 'kortfristigaFordringar'],
    ['1630', 'kortfristigaFordringar'],
    ['1790', 'kortfristigaFordringar'],
    ['1690', 'tecknatEjInbetaltKapital'],
    ['1930', 'kassaBank'],
    ['2081', 'bundetEgetKapital'],
    ['2091', 'frittEgetKapital'],
    ['2099', 'frittEgetKapital'],
    ['2110', 'obeskattadeReserver'],
    ['2350', 'langfristigaSkulder'],
    ['2440', 'kortfristigaSkulder'],
    ['2641', 'kortfristigaSkulder'],
    ['2991', 'kortfristigaSkulder'],
  ])('places %s under %s for an aktiebolag', (account, expected) => {
    expect(k2BrSectionForAccount(account, 'aktiebolag')).toBe(expected)
  })

  it('returns null where no post covers the account', () => {
    expect(k2BrSectionForAccount('1200', 'aktiebolag')).toBeNull()
    expect(k2BrSectionForAccount('2010', 'aktiebolag')).toBeNull()
    expect(k2BrSectionForAccount('2205', 'aktiebolag')).toBeNull()
  })

  it('follows the förening equity table', () => {
    expect(k2BrSectionForAccount('2083', 'ekonomisk_forening')).toBe('bundetEgetKapital')
    expect(k2BrSectionForAccount('2084', 'ekonomisk_forening')).toBe('bundetEgetKapital')
    // Share capital does not exist in a förening: the mapper flags it as unmapped.
    expect(k2BrSectionForAccount('2081', 'ekonomisk_forening')).toBeNull()
    expect(k2BrSectionForAccount('1930', 'ekonomisk_forening')).toBe('kassaBank')
  })

  it('returns null exactly for the accounts the mapper reports as unmapped', () => {
    const tb = [row('1200', 100, 0), row('2010', 0, 100), row('1930', 50, 0), row('2099', 0, 50)]
    const result = mapTrialBalancesToK2({ full: tb, preClosing: tb }, null)
    for (const r of tb) {
      const unmapped = result.unmappedAccounts.some((u) => u.account === r.account_number)
      expect(k2BrSectionForAccount(r.account_number, 'aktiebolag') === null, r.account_number).toBe(unmapped)
    }
  })
})

describe('k2LegalFormFor', () => {
  it('maps member capital to the förening table and every other form to the share-capital table', () => {
    expect(k2LegalFormFor('ekonomisk_forening')).toBe('ekonomisk_forening')
    expect(k2LegalFormFor('aktiebolag')).toBe('aktiebolag')
    expect(k2LegalFormFor('enskild_firma')).toBe('aktiebolag')
    expect(k2LegalFormFor('ideell_forening')).toBe('aktiebolag')
  })
})
