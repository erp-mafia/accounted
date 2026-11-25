import { describe, expect, it } from 'vitest'
import { K2_BR_MAPPINGS, k2BrPostForAccount } from '@/lib/bokslut/ixbrl/k2-mapper'
import { k2AssetPostLabel } from '@/lib/bokslut/ixbrl/document/statements'
import type { AnlaggningAsset } from '../anlaggningstillgangar-note'
import {
  buildK2FixedAssetTables,
  carriedFromEarlierYears,
  fixedAssetNoteBody,
  fixedAssetNoteCarryingTotal,
  fixedAssetOpeningCarrying,
  alignCarryingWithBalanceSheet,
  fixedAssetPostTieOut,
  mergeFixedAssetNoteRows,
  normalizeFixedAssetNoteRows,
  statedRowIssue,
  statedTranslationIssues,
  statedWriteDownIssues,
  unstatedWriteDownReleases,
  type CarriedOpening,
  type FixedAssetNoteRows,
  type FixedAssetNoteTable,
  type WriteDownsOutsideRegister,
} from '../k2-fixed-asset-note'

const PERIOD_START = '2025-01-01'
const PERIOD_END = '2025-12-31'

function makeAsset(overrides: Partial<AnlaggningAsset> = {}): AnlaggningAsset {
  return {
    category: 'equipment',
    acquisition_date: '2024-01-01',
    acquisition_cost: 60_000,
    salvage_value: 0,
    useful_life_months: 60,
    disposed_at: null,
    bas_asset_account: '1220',
    figures: { ibAck: 0, aretsAvskrivning: 0, avgaendeAck: 0 },
    ...overrides,
  }
}

function build(
  assets: AnlaggningAsset[],
  stated: FixedAssetNoteRows = {},
  outsideWriteDowns?: ReadonlyMap<string, WriteDownsOutsideRegister>,
  carried?: ReadonlyMap<string, CarriedOpening>,
) {
  return buildK2FixedAssetTables({
    assets,
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    stated,
    postOfAccount: (account) => k2BrPostForAccount(account, 'aktiebolag'),
    labelOfPost: (post) => k2AssetPostLabel(post) ?? post,
    postOrder: K2_BR_MAPPINGS.map((mapping) => mapping.concept),
    outsideWriteDowns,
    carried,
  })
}

/** The PDF amount format groups thousands with a no-break space. */
const plainSpaces = (text: string) => text.replace(/[  ]/g, ' ')

function amounts(table: FixedAssetNoteTable): Record<string, number> {
  return Object.fromEntries(table.blocks.flatMap((block) => block.rows.map((row) => [row.key, row.amount])))
}

describe('buildK2FixedAssetTables: the register per balance sheet post', () => {
  it('sums register categories that share a post into one table, in balance sheet order', () => {
    const tables = build([
      makeAsset({ category: 'computer', bas_asset_account: '1250', acquisition_cost: 20_000, figures: { ibAck: 4_000, aretsAvskrivning: 4_000, avgaendeAck: 0 } }),
      makeAsset({ category: 'equipment', bas_asset_account: '1220', acquisition_cost: 60_000, figures: { ibAck: 12_000, aretsAvskrivning: 12_000, avgaendeAck: 0 } }),
      makeAsset({ category: 'building', bas_asset_account: '1110', acquisition_cost: 1_000_000, figures: { ibAck: 50_000, aretsAvskrivning: 25_000, avgaendeAck: 0 } }),
    ])
    expect(tables.map((table) => table.post)).toEqual(['ByggnaderMark', 'InventarierVerktygInstallationer'])
    expect(tables.map((table) => table.label)).toEqual(['Byggnader och mark', 'Inventarier, verktyg och installationer'])
    expect(amounts(tables[1])).toEqual({
      'cost.opening': 80_000,
      'cost.closing': 80_000,
      'depreciation.opening': 16_000,
      'depreciation.arets': 16_000,
      'depreciation.closing': 32_000,
    })
    expect(tables[1].carrying).toBe(48_000)
  })

  it('prints the year the register tells: inköp, försäljningar and the write-downs', () => {
    const tables = build([
      makeAsset({ acquisition_date: '2025-03-01', acquisition_cost: 30_000, figures: { ibAck: 0, aretsAvskrivning: 5_000, avgaendeAck: 0 } }),
      makeAsset({
        disposed_at: '2025-06-30',
        acquisition_cost: 40_000,
        figures: { ibAck: 8_000, aretsAvskrivning: 4_000, avgaendeAck: 12_000 },
        writeDowns: { opening: 3_000, writtenDown: 2_000, reversed: 1_000, disposed: 4_000, closing: 0 },
      }),
    ])
    expect(amounts(tables[0])).toEqual({
      'cost.opening': 40_000,
      'cost.inkop': 30_000,
      'cost.forsaljningar': 40_000,
      'cost.closing': 30_000,
      'depreciation.opening': 8_000,
      'depreciation.forsaljningar': 12_000,
      'depreciation.arets': 9_000,
      'depreciation.closing': 5_000,
      'impairment.opening': 3_000,
      'impairment.forsaljningar': 4_000,
      'impairment.aterforda': 1_000,
      'impairment.arets': 2_000,
      'impairment.closing': 0,
    })
    expect(tables[0].carrying).toBe(25_000)
  })

  it('keeps an asset without an account in a post as a table of its own, untagged', () => {
    const tables = build([makeAsset({ category: 'other_tangible', bas_asset_account: undefined })])
    expect(tables).toHaveLength(1)
    expect(tables[0].post).toBeNull()
    expect(tables[0].label).toBe('Övriga materiella anläggningstillgångar')
  })

  it('has no table without assets and without stated rows', () => {
    expect(build([])).toEqual([])
  })

  it('prints an asset booked on a post with other rows under that post\'s name, untagged', () => {
    // A building registered on 1180 sits in pågående nyanläggningar on the
    // balance sheet: the taxonomy gives that post's note other rows.
    const tables = build([
      makeAsset({ category: 'building', bas_asset_account: '1180', acquisition_cost: 400_000 }),
      makeAsset({ category: 'building', bas_asset_account: '1110', acquisition_cost: 1_000_000 }),
    ])
    expect(tables.map((table) => [table.post, table.label])).toEqual([
      ['ByggnaderMark', 'Byggnader och mark'],
      [null, 'Pågående nyanläggningar och förskott avseende materiella anläggningstillgångar'],
    ])
    expect(tables[1].carrying).toBe(400_000)
  })
})

describe('buildK2FixedAssetTables: how the year\'s new assets came in', () => {
  const cameIn = (acquisition_type: AnlaggningAsset['acquisition_type'], overrides: Partial<AnlaggningAsset> = {}) =>
    makeAsset({ category: 'machinery', bas_asset_account: '1210', acquisition_date: '2025-04-01', acquisition_type, ...overrides })

  it('puts each new asset on the row of how it was acquired', () => {
    const tables = build([
      cameIn('purchase', { acquisition_cost: 10_000 }),
      cameIn(undefined, { acquisition_cost: 5_000 }),
      cameIn('business_acquisition', { acquisition_cost: 20_000 }),
      cameIn('merger', { acquisition_cost: 30_000 }),
      cameIn('reclassification', { acquisition_cost: 40_000 }),
    ])
    expect(tables.map((table) => table.post)).toEqual(['MaskinerAndraTekniskaAnlaggningar'])
    expect(amounts(tables[0])).toEqual({
      'cost.opening': 0,
      // An asset without a stated type is a purchase.
      'cost.inkop': 15_000,
      'cost.rorelseforvarv': 20_000,
      'cost.fusion': 30_000,
      'cost.omklassificeringar': 40_000,
      'cost.closing': 105_000,
    })
  })

  it('counts only the year\'s new assets: how an older asset once came in is history', () => {
    const tables = build([cameIn('merger', { acquisition_date: '2023-05-01', acquisition_cost: 30_000 })])
    expect(amounts(tables[0])).toEqual({ 'cost.opening': 30_000, 'cost.closing': 30_000 })
  })

  it('shows the avskrivningar an asset carried when it came in by fusion on the fusion row', () => {
    // Taken over at 100 000 with 40 000 depreciated; 6 000 more in the year.
    const tables = build([
      cameIn('merger', { acquisition_cost: 100_000, figures: { ibAck: 40_000, aretsAvskrivning: 6_000, avgaendeAck: 0 } }),
    ])
    expect(amounts(tables[0])).toEqual({
      'cost.opening': 0,
      'cost.fusion': 100_000,
      'cost.closing': 100_000,
      'depreciation.opening': 0,
      'depreciation.fusion': 40_000,
      'depreciation.arets': 6_000,
      'depreciation.closing': 46_000,
    })
    expect(tables[0].carrying).toBe(54_000)
  })

  it('shows what came in with an omklassificering as an increase of the avskrivningar: a negative amount on a "minskning (ökning)" row', () => {
    const tables = build([
      cameIn('reclassification', { acquisition_cost: 80_000, figures: { ibAck: 25_000, aretsAvskrivning: 5_000, avgaendeAck: 0 } }),
    ])
    expect(amounts(tables[0])).toEqual({
      'cost.opening': 0,
      'cost.omklassificeringar': 80_000,
      'cost.closing': 80_000,
      'depreciation.opening': 0,
      'depreciation.omklassificeringar': -25_000,
      'depreciation.arets': 5_000,
      'depreciation.closing': 30_000,
    })
    expect(tables[0].carrying).toBe(50_000)
  })

  it('counts what a previous system depreciated on an asset bought in the year as the year\'s avskrivningar', () => {
    // Bought in April, 3 000 depreciated in the old system before the move
    // to Accounted, 6 000 more posted here: the year's avskrivningar are 9 000.
    const tables = build([
      cameIn('purchase', { acquisition_cost: 60_000, figures: { ibAck: 3_000, aretsAvskrivning: 6_000, avgaendeAck: 0 } }),
    ])
    expect(amounts(tables[0])).toMatchObject({
      'depreciation.opening': 0,
      'depreciation.arets': 9_000,
      'depreciation.closing': 9_000,
    })
  })

  it('nets a taken-over asset sold the same year out of every block', () => {
    const tables = build([
      cameIn('merger', {
        acquisition_cost: 100_000,
        disposed_at: '2025-11-30',
        figures: { ibAck: 40_000, aretsAvskrivning: 5_000, avgaendeAck: 45_000 },
      }),
    ])
    expect(amounts(tables[0])).toEqual({
      'cost.opening': 0,
      'cost.fusion': 100_000,
      'cost.forsaljningar': 100_000,
      'cost.closing': 0,
      'depreciation.opening': 0,
      'depreciation.fusion': 40_000,
      'depreciation.forsaljningar': 45_000,
      'depreciation.arets': 5_000,
      'depreciation.closing': 0,
    })
    expect(tables[0].carrying).toBe(0)
  })

  it('prints goodwill the register holds as bought as rörelseförvärv: the taxonomy has no inköp for it', () => {
    const tables = build([
      makeAsset({ category: 'immaterial', bas_asset_account: '1070', acquisition_date: '2025-02-01', acquisition_cost: 200_000 }),
      makeAsset({ category: 'immaterial', bas_asset_account: '1070', acquisition_date: '2025-02-01', acquisition_cost: 50_000, acquisition_type: 'business_acquisition' }),
      makeAsset({ category: 'immaterial', bas_asset_account: '1070', acquisition_date: '2025-02-01', acquisition_cost: 30_000, acquisition_type: 'merger' }),
    ])
    expect(tables[0].post).toBe('Goodwill')
    expect(amounts(tables[0])).toEqual({
      'cost.opening': 0,
      'cost.rorelseforvarv': 250_000,
      'cost.fusion': 30_000,
      'cost.closing': 280_000,
    })
  })
})

describe('buildK2FixedAssetTables: the rows the user states', () => {
  const machine = (overrides: Partial<AnlaggningAsset> = {}) =>
    makeAsset({ category: 'machinery', bas_asset_account: '1210', acquisition_cost: 500_000, ...overrides })

  it('adds omräkningsdifferenser by the direction their standard label names', () => {
    const tables = build(
      [machine({ figures: { ibAck: 100_000, aretsAvskrivning: 50_000, avgaendeAck: 0 } })],
      { MaskinerAndraTekniskaAnlaggningar: { 'cost.omrakningsdifferenser': 12_000, 'depreciation.omrakningsdifferenser': -3_000 } },
    )
    expect(amounts(tables[0])).toEqual({
      'cost.opening': 500_000,
      // "Ökning (minskning)": a positive amount raises the anskaffningsvärden.
      'cost.omrakningsdifferenser': 12_000,
      'cost.closing': 512_000,
      'depreciation.opening': 100_000,
      'depreciation.arets': 50_000,
      // "Minskning (ökning)": a negative amount raises the accumulated avskrivningar.
      'depreciation.omrakningsdifferenser': -3_000,
      'depreciation.closing': 153_000,
    })
    expect(tables[0].carrying).toBe(359_000)
  })

  it('gives a post with stated rows its table even without a register asset', () => {
    const tables = build([], { ByggnaderMark: { 'cost.omrakningsdifferenser': 5_000 } })
    expect(tables).toHaveLength(1)
    expect(tables[0].post).toBe('ByggnaderMark')
    expect(amounts(tables[0])).toEqual({ 'cost.opening': 0, 'cost.omrakningsdifferenser': 5_000, 'cost.closing': 5_000 })
  })

  it('ignores rows stated for a post that is not one of the note\'s', () => {
    const stated = { AndelarKoncernforetag: { 'cost.omrakningsdifferenser': 5_000 } } as unknown as FixedAssetNoteRows
    expect(build([machine()], stated).map((table) => table.post)).toEqual(['MaskinerAndraTekniskaAnlaggningar'])
  })
})

describe('what the earlier years stated carries into the opening balances', () => {
  const machine = (overrides: Partial<AnlaggningAsset> = {}) =>
    makeAsset({ category: 'machinery', bas_asset_account: '1210', acquisition_cost: 500_000, ...overrides })

  it('sums the omräkningsdifferenser of the years before, per post and in the direction of each row', () => {
    const carried = carriedFromEarlierYears([
      { MaskinerAndraTekniskaAnlaggningar: { 'cost.omrakningsdifferenser': 12_000, 'depreciation.omrakningsdifferenser': -3_000 } },
      // A year that states nothing leaves the balances as they were.
      {},
      {
        MaskinerAndraTekniskaAnlaggningar: { 'cost.omrakningsdifferenser': -2_000 },
        ByggnaderMark: { 'depreciation.omrakningsdifferenser': 5_000 },
      },
    ])
    expect([...carried.entries()]).toEqual([
      // "Ökning (minskning)": +12 000 - 2 000 in the anskaffningsvärden.
      // "Minskning (ökning)": -3 000 raised the accumulated avskrivningar by 3 000.
      ['MaskinerAndraTekniskaAnlaggningar', { cost: 10_000, depreciation: 3_000 }],
      ['ByggnaderMark', { cost: 0, depreciation: -5_000 }],
    ])
  })

  it('carries nothing for the nedskrivning rows: the ledger holds that balance', () => {
    expect(carriedFromEarlierYears([{ ByggnaderMark: { 'impairment.fusion': 11_000, 'impairment.omklassificeringar': 4_000 } }]).size).toBe(0)
  })

  it('forgets a difference a later year took out again', () => {
    const carried = carriedFromEarlierYears([
      { ByggnaderMark: { 'cost.omrakningsdifferenser': 8_000 } },
      // The asset was sold: the opposite amount takes the difference out.
      { ByggnaderMark: { 'cost.omrakningsdifferenser': -8_000 } },
    ])
    expect(carried.size).toBe(0)
  })

  it('opens the year with the register and what was carried, and rolls forward from there', () => {
    const tables = build(
      [machine({ figures: { ibAck: 100_000, aretsAvskrivning: 50_000, avgaendeAck: 0 } })],
      {},
      undefined,
      new Map([['MaskinerAndraTekniskaAnlaggningar', { cost: 10_000, depreciation: 3_000 }]]),
    )
    expect(amounts(tables[0])).toEqual({
      'cost.opening': 510_000,
      'cost.closing': 510_000,
      'depreciation.opening': 103_000,
      'depreciation.arets': 50_000,
      'depreciation.closing': 153_000,
    })
    expect(fixedAssetOpeningCarrying(tables[0])).toBe(407_000)
    expect(tables[0].carrying).toBe(357_000)
  })

  it('gives a post that only carries an amount its table', () => {
    const tables = build([], {}, undefined, new Map([['ByggnaderMark', { cost: 5_000, depreciation: 0 }]]))
    expect(tables.map((table) => table.post)).toEqual(['ByggnaderMark'])
    expect(amounts(tables[0])).toEqual({ 'cost.opening': 5_000, 'cost.closing': 5_000 })
  })
})

describe('the tie of each post to its books', () => {
  const stated: FixedAssetNoteRows = { ByggnaderMark: { 'cost.omrakningsdifferenser': 70_000 } }
  const statedPosts = new Set(Object.keys(stated))
  const tables = () =>
    build(
      [
        makeAsset({ category: 'building', bas_asset_account: '1110', acquisition_cost: 1_000_000 }),
        makeAsset({ acquisition_cost: 60_000 }),
      ],
      stated,
    )
  const books = (closing: Record<string, number>, opening: Record<string, number>) => ({
    closing: (post: string) => closing[post],
    opening: (post: string) => opening[post],
  })
  const OPENING = { ByggnaderMark: 1_000_000, InventarierVerktygInstallationer: 60_000 }

  it('says nothing when every post is within a krona of its books at both ends of the year', () => {
    const closing = { ByggnaderMark: 1_070_000.6, InventarierVerktygInstallationer: 60_000 }
    expect(fixedAssetPostTieOut(tables(), statedPosts, books(closing, OPENING))).toEqual({
      errors: [],
      closingWarnings: [],
      openingWarnings: [],
      closingBlocked: false,
      untiedPosts: new Set(),
    })
  })

  it('blocks a post with stated rows and only warns for one the register alone fills', () => {
    const closing = { ByggnaderMark: 1_000_000, InventarierVerktygInstallationer: 50_000 }
    const result = fixedAssetPostTieOut(tables(), statedPosts, books(closing, OPENING))
    expect(result.errors).toHaveLength(1)
    expect(plainSpaces(result.errors[0])).toContain('Anläggningsnoten för Byggnader och mark: redovisat värde (1 070 000 kr)')
    expect(result.errors[0]).toContain('innan årsredovisningen kan låsas')
    expect(result.closingBlocked).toBe(true)
    expect(result.closingWarnings).toHaveLength(1)
    expect(plainSpaces(result.closingWarnings[0])).toContain('Anläggningsnoten för Inventarier, verktyg och installationer: redovisat värde (60 000 kr)')
    expect(result.openingWarnings).toEqual([])
  })

  it('compares the opening balance of a post that closes right', () => {
    // The building was bought in the year and booked then, but is registered
    // with an earlier date: the note opens with 1 000 000 the books did not hold.
    const closing = { ByggnaderMark: 1_070_000, InventarierVerktygInstallationer: 60_000 }
    const opening = { ByggnaderMark: 0, InventarierVerktygInstallationer: 0 }
    const result = fixedAssetPostTieOut(tables(), statedPosts, books(closing, opening))
    expect(result.errors).toHaveLength(1)
    expect(plainSpaces(result.errors[0])).toContain(
      'Anläggningsnoten för Byggnader och mark: ingående redovisat värde (1 000 000 kr) stämmer inte med postens bokförda värde vid årets ingång (0 kr)',
    )
    expect(result.errors[0]).toContain('innan årsredovisningen kan låsas')
    // The post closes right: the note-level check still runs.
    expect(result.closingBlocked).toBe(false)
    expect(result.closingWarnings).toEqual([])
    expect(result.openingWarnings).toHaveLength(1)
    expect(plainSpaces(result.openingWarnings[0])).toContain('Anläggningsnoten för Inventarier, verktyg och installationer: ingående redovisat värde (60 000 kr)')
    // Both name what the register can hold that opens a post wrong.
    for (const message of [result.errors[0], result.openingWarnings[0]]) {
      expect(message).toContain('har ett tidigare anskaffningsdatum än dagen den kom in')
      expect(message).toContain('redan avskrivet belopp är angivet per ett datum inne i året')
      expect(message).toContain('flyttats till ett konto i en annan post')
      expect(message).toContain('avyttring är bokförd ett annat år än den är registrerad')
    }
  })

  it('names the posts that do not tie, at either end of the year', () => {
    const closingOff = fixedAssetPostTieOut(tables(), statedPosts, books({ ByggnaderMark: 1_000_000, InventarierVerktygInstallationer: 60_000 }, OPENING))
    expect([...closingOff.untiedPosts]).toEqual(['ByggnaderMark'])
    const openingOff = fixedAssetPostTieOut(
      tables(),
      statedPosts,
      books({ ByggnaderMark: 1_070_000, InventarierVerktygInstallationer: 60_000 }, { ByggnaderMark: 1_000_000, InventarierVerktygInstallationer: 0 }),
    )
    expect([...openingOff.untiedPosts]).toEqual(['InventarierVerktygInstallationer'])
  })

  it('reports one cause per post: a post that closes wrong is not also reported for its opening', () => {
    const closing = { ByggnaderMark: 1_000_000, InventarierVerktygInstallationer: 60_000 }
    const opening = { ByggnaderMark: 0, InventarierVerktygInstallationer: 60_000 }
    const result = fixedAssetPostTieOut(tables(), statedPosts, books(closing, opening))
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('redovisat värde (')
    expect(result.errors[0]).not.toContain('ingående redovisat värde')
    expect(result.closingWarnings).toEqual([])
    expect(result.openingWarnings).toEqual([])
  })

  it('treats a post that carries an amount from earlier years as stated: its ties block', () => {
    const carried = new Map([['InventarierVerktygInstallationer', { cost: 5_000, depreciation: 0 }]])
    const carriedTables = build([makeAsset({ acquisition_cost: 60_000 })], {}, undefined, carried)
    const { errors } = fixedAssetPostTieOut(
      carriedTables,
      new Set(carried.keys()),
      books({ InventarierVerktygInstallationer: 60_000 }, { InventarierVerktygInstallationer: 65_000 }),
    )
    expect(errors).toHaveLength(1)
    expect(plainSpaces(errors[0])).toContain('redovisat värde (65 000 kr)')
  })

  it('reads the opening redovisat värde off the blocks', () => {
    const table = build([
      makeAsset({
        acquisition_cost: 60_000,
        figures: { ibAck: 12_000, aretsAvskrivning: 12_000, avgaendeAck: 0 },
        writeDowns: { opening: 3_000, writtenDown: 0, reversed: 0, disposed: 0, closing: 3_000 },
      }),
    ])[0]
    expect(fixedAssetOpeningCarrying(table)).toBe(45_000)
  })

  it('sums the note over every table', () => {
    expect(fixedAssetNoteCarryingTotal(tables())).toBe(1_130_000)
  })
})

describe('nedskrivningar the ledger holds beyond the register', () => {
  const building = (overrides: Partial<AnlaggningAsset> = {}) =>
    makeAsset({ category: 'building', bas_asset_account: '1110', acquisition_cost: 1_000_000, ...overrides })
  const impairment = (assets: AnlaggningAsset[], stated: FixedAssetNoteRows, outside: WriteDownsOutsideRegister) => {
    const tables = build(assets, stated, new Map([['ByggnaderMark', outside]]))
    const rows = amounts(tables[0])
    return Object.fromEntries(Object.entries(rows).filter(([key]) => key.startsWith('impairment.')))
  }

  it('shows a nedskrivning booked by hand in the post\'s table', () => {
    expect(impairment([building()], {}, { opening: 0, written: 40_000, released: 0 })).toEqual({
      'impairment.opening': 0,
      'impairment.arets': 40_000,
      'impairment.closing': 40_000,
    })
  })

  it('opens with what last year closed with, whatever source last year\'s rows had', () => {
    // 11 000 came in through a fusion last year and was stated then: this
    // year the ledger holds it and the register does not.
    expect(impairment([building()], {}, { opening: 11_000, written: 0, released: 0 })).toEqual({
      'impairment.opening': 11_000,
      'impairment.closing': 11_000,
    })
  })

  it('takes a stated nedskrivning out of what the accounts gained beyond the register: it is booked there', () => {
    // 11 000 from the fusion and 30 000 by hand were credited in the year.
    expect(impairment([building()], { ByggnaderMark: { 'impairment.fusion': 11_000 } }, { opening: 0, written: 41_000, released: 0 })).toEqual({
      'impairment.opening': 0,
      'impairment.fusion': 11_000,
      'impairment.arets': 30_000,
      'impairment.closing': 41_000,
    })
  })

  it('takes a stated decrease out of what the accounts released beyond the register', () => {
    // 11 000 from before was moved out of the post in the year.
    expect(impairment([building()], { ByggnaderMark: { 'impairment.omklassificeringar': 11_000 } }, { opening: 11_000, written: 0, released: 11_000 })).toEqual({
      'impairment.opening': 11_000,
      'impairment.omklassificeringar': 11_000,
      'impairment.closing': 0,
    })
  })

  it('shows what left the write-down accounts with an asset sold or scrapped on that row, not as an återföring', () => {
    // 9 000 written down by hand before the year left when the asset was sold.
    expect(impairment([building()], { ByggnaderMark: { 'impairment.forsaljningar': 9_000 } }, { opening: 9_000, written: 0, released: 9_000 })).toEqual({
      'impairment.opening': 9_000,
      'impairment.forsaljningar': 9_000,
      'impairment.closing': 0,
    })
  })

  it('adds a stated försäljning to what the register disposed of', () => {
    const disposed = building({
      disposed_at: '2025-06-30',
      figures: { ibAck: 0, aretsAvskrivning: 0, avgaendeAck: 0 },
      writeDowns: { opening: 20_000, writtenDown: 0, reversed: 0, disposed: 20_000, closing: 0 },
    })
    expect(impairment([disposed], { ByggnaderMark: { 'impairment.forsaljningar': 9_000 } }, { opening: 9_000, written: 0, released: 9_000 })).toEqual({
      'impairment.opening': 29_000,
      'impairment.forsaljningar': 29_000,
      'impairment.closing': 0,
    })
  })

  it('reads a negative omklassificering or omräkningsdifferens as nedskrivningar that came in', () => {
    // 8 000 moved in with an asset from another post, 2 000 more from an
    // omräkning: both were credited to the post's write-down accounts.
    expect(
      impairment(
        [building()],
        { ByggnaderMark: { 'impairment.omklassificeringar': -8_000, 'impairment.omrakningsdifferenser': -2_000 } },
        { opening: 0, written: 10_000, released: 0 },
      ),
    ).toEqual({
      'impairment.opening': 0,
      'impairment.omklassificeringar': -8_000,
      'impairment.omrakningsdifferenser': -2_000,
      'impairment.closing': 10_000,
    })
  })

  it('adds the register\'s own nedskrivningar to what the ledger holds beyond them', () => {
    // The register wrote 20 000 down before the year; 40 000 more are from
    // before Accounted. In the year 10 000 were reversed by hand and 6 000
    // were moved out of the post and stated.
    const registered = building({ writeDowns: { opening: 20_000, writtenDown: 0, reversed: 0, disposed: 0, closing: 20_000 } })
    expect(impairment([registered], { ByggnaderMark: { 'impairment.omklassificeringar': 6_000 } }, { opening: 40_000, written: 0, released: 16_000 })).toEqual({
      'impairment.opening': 60_000,
      'impairment.aterforda': 10_000,
      'impairment.omklassificeringar': 6_000,
      'impairment.closing': 44_000,
    })
  })

  it('takes nothing out for a stated nedskrivning the write-down accounts do not hold: the post is then left untied', () => {
    expect(impairment([building()], { ByggnaderMark: { 'impairment.fusion': 11_000 } }, { opening: 40_000, written: 0, released: 0 })).toEqual({
      'impairment.opening': 40_000,
      'impairment.fusion': 11_000,
      'impairment.closing': 51_000,
    })
  })
})

describe('statedWriteDownIssues', () => {
  const label = (post: string) => k2AssetPostLabel(post) ?? post
  const outside = (written: number, released: number) =>
    new Map<string, WriteDownsOutsideRegister>([['ByggnaderMark', { opening: 50_000, written, released }]])

  it('says nothing when the rows fit what the write-down accounts moved beyond the register', () => {
    const stated: FixedAssetNoteRows = { ByggnaderMark: { 'impairment.fusion': 11_000, 'impairment.omklassificeringar': 6_000 } }
    expect(statedWriteDownIssues(stated, outside(11_000, 6_000), label)).toEqual([])
    // Whole kronor against accounts in öre.
    expect(statedWriteDownIssues(stated, outside(10_999.6, 5_999.5), label)).toEqual([])
  })

  it('lets the krona cover rounding of what is booked, never a row with nothing booked in its direction', () => {
    const one: FixedAssetNoteRows = { ByggnaderMark: { 'impairment.fusion': 1, 'impairment.forsaljningar': 1 } }
    // 40 öre booked each way round to nothing, and a krona stated is within the rounding.
    expect(statedWriteDownIssues(one, outside(0.4, 0.4), label)).toEqual([])
    // Nothing booked at all: a single krona is still a movement the books do not hold.
    const issues = statedWriteDownIssues(one, outside(0, 0), label)
    expect(issues).toHaveLength(2)
    expect(plainSpaces(issues[0])).toContain('ökar nedskrivningarna med 1 kr, men postens nedskrivningskonton har krediterats 0 kr')
    expect(plainSpaces(issues[1])).toContain('minskar nedskrivningarna med 1 kr, men postens nedskrivningskonton har debiterats 0 kr')
  })

  it('refuses rows that raise the nedskrivningar by more than the accounts were credited', () => {
    const issues = statedWriteDownIssues({ ByggnaderMark: { 'impairment.fusion': 20_000 } }, outside(10_000, 0), label)
    expect(issues).toHaveLength(1)
    expect(plainSpaces(issues[0])).toContain(
      'Anläggningsnoten för Byggnader och mark: de angivna raderna ökar nedskrivningarna med 20 000 kr, men postens nedskrivningskonton har krediterats 10 000 kr utöver anläggningsregistret',
    )
  })

  it('refuses rows that cancel in the closing balance but that the accounts support in neither direction', () => {
    // The accounts were credited 10 000 and never debited. A fusion of
    // 20 000 and a försäljning of 10 000 close at the same 60 000.
    const stated: FixedAssetNoteRows = { ByggnaderMark: { 'impairment.fusion': 20_000, 'impairment.forsaljningar': 10_000 } }
    const tables = build([makeAsset({ category: 'building', bas_asset_account: '1110', acquisition_cost: 1_000_000 })], stated, outside(10_000, 0))
    expect(amounts(tables[0])['impairment.closing']).toBe(60_000)
    const issues = statedWriteDownIssues(stated, outside(10_000, 0), label)
    expect(issues).toHaveLength(2)
    expect(plainSpaces(issues[1])).toContain('minskar nedskrivningarna med 10 000 kr, men postens nedskrivningskonton har debiterats 0 kr')
  })

  it('counts a negative omklassificering or omräkningsdifferens as an increase', () => {
    const stated: FixedAssetNoteRows = { ByggnaderMark: { 'impairment.omklassificeringar': -8_000, 'impairment.omrakningsdifferenser': -2_000 } }
    expect(statedWriteDownIssues(stated, outside(10_000, 0), label)).toEqual([])
    expect(statedWriteDownIssues(stated, outside(5_000, 0), label)).toHaveLength(1)
  })

  it('refuses a stated nedskrivning row on a post whose accounts hold nothing beyond the register', () => {
    expect(statedWriteDownIssues({ Goodwill: { 'impairment.fusion': 5_000 } }, new Map(), label)).toHaveLength(1)
    expect(statedWriteDownIssues({ Goodwill: { 'cost.omrakningsdifferenser': 5_000 } }, undefined, label)).toEqual([])
  })
})

describe('statedTranslationIssues', () => {
  // Equipment of 60 000 from before the year, 12 000 depreciated in it.
  const equipment = makeAsset({ figures: { ibAck: 12_000, aretsAvskrivning: 12_000, avgaendeAck: 0 } })
  const POST = 'InventarierVerktygInstallationer'
  const gross = (cost: number, depreciation: number | null) => new Map([[POST, { cost, depreciation }]])
  const check = (stated: FixedAssetNoteRows, moved: ReturnType<typeof gross>, assets = [equipment]) =>
    statedTranslationIssues(build(assets, stated), stated, moved).map(plainSpaces)

  it('says nothing when the accounts moved what the rows state, beyond the register', () => {
    // 8 000 on the anskaffningskonto; the accumulated account gained the
    // year's 12 000 and 3 000 more ("minskning (ökning)": stated as -3 000).
    const stated: FixedAssetNoteRows = { [POST]: { 'cost.omrakningsdifferenser': 8_000, 'depreciation.omrakningsdifferenser': -3_000 } }
    expect(check(stated, gross(8_000, 15_000))).toEqual([])
    // Whole kronor against accounts in öre.
    expect(check(stated, gross(8_000.4, 14_999.5))).toEqual([])
  })

  it('refuses two rows that cancel in the redovisat värde when neither is booked', () => {
    // Nothing moved beyond the year's depreciation: 20 000 more cost and
    // 20 000 more avskrivningar leave the post's value where it was.
    const stated: FixedAssetNoteRows = { [POST]: { 'cost.omrakningsdifferenser': 20_000, 'depreciation.omrakningsdifferenser': -20_000 } }
    const issues = check(stated, gross(0, 12_000))
    expect(issues).toHaveLength(2)
    expect(issues[0]).toContain(
      'Anläggningsnoten för Inventarier, verktyg och installationer: omräkningsdifferensen i anskaffningsvärdena är angiven till 20 000 kr, men postens anskaffningskonton har under året ändrats med 0 kr utöver anläggningsregistret.',
    )
    expect(issues[1]).toContain('omräkningsdifferensen i avskrivningarna är angiven till \u221220 000 kr')
    expect(issues[1]).toContain('har under året ändrats med 0 kr utöver anläggningsregistret')
  })

  it('takes the register\'s own rows of the year out of what the accounts moved', () => {
    // A machine bought in the year for 50 000 is on the same accounts.
    const bought = makeAsset({ acquisition_date: '2025-04-01', acquisition_cost: 50_000 })
    const stated: FixedAssetNoteRows = { [POST]: { 'cost.omrakningsdifferenser': 8_000 } }
    expect(check(stated, gross(58_000, 12_000), [equipment, bought])).toEqual([])
    expect(check(stated, gross(50_000, 12_000), [equipment, bought])).toHaveLength(1)
  })

  it('checks only the block a row is stated in, and no avskrivningar that cannot be told from nedskrivningar', () => {
    const cost: FixedAssetNoteRows = { [POST]: { 'cost.omrakningsdifferenser': 8_000 } }
    // The accumulated account moved something the note does not explain: the post's tie reports that.
    expect(check(cost, gross(8_000, 99_000))).toEqual([])
    const depreciation: FixedAssetNoteRows = { [POST]: { 'depreciation.omrakningsdifferenser': -3_000 } }
    expect(check(depreciation, gross(0, null))).toEqual([])
    expect(check(depreciation, gross(0, 12_000))).toHaveLength(1)
  })

  it('treats a post that is not on the books as having moved nothing', () => {
    const stated: FixedAssetNoteRows = { [POST]: { 'cost.omrakningsdifferenser': 8_000 } }
    expect(statedTranslationIssues(build([equipment], stated), stated, new Map())).toHaveLength(1)
    expect(statedTranslationIssues(build([equipment]), {}, new Map())).toEqual([])
  })
})

describe('unstatedWriteDownReleases', () => {
  const building = makeAsset({ category: 'building', bas_asset_account: '1110', acquisition_cost: 1_000_000 })
  const outside = (released: number) =>
    new Map<string, WriteDownsOutsideRegister>([['ByggnaderMark', { opening: 50_000, written: 0, released }]])

  it('names what the accounts released beyond the register that prints as återförda nedskrivningar', () => {
    const notices = unstatedWriteDownReleases(build([building], {}, outside(20_000)), {}, outside(20_000))
    expect(notices).toHaveLength(1)
    expect(plainSpaces(notices[0])).toContain(
      'Nedskrivningar utanför anläggningsregistret, Byggnader och mark: postens nedskrivningskonton har debiterats 20 000 kr under året utöver registret, och noten visar beloppet som återförda nedskrivningar.',
    )
    expect(notices[0]).toContain('sålts eller utrangerats')
  })

  it('counts only what no stated row accounts for', () => {
    const stated: FixedAssetNoteRows = { ByggnaderMark: { 'impairment.forsaljningar': 12_000 } }
    const notices = unstatedWriteDownReleases(build([building], stated, outside(20_000)), stated, outside(20_000))
    expect(plainSpaces(notices[0])).toContain('har debiterats 8 000 kr under året')
    const all: FixedAssetNoteRows = { ByggnaderMark: { 'impairment.forsaljningar': 12_000, 'impairment.omklassificeringar': 8_000 } }
    expect(unstatedWriteDownReleases(build([building], all, outside(20_000)), all, outside(20_000))).toEqual([])
  })

  it('says nothing without a release, within the krona rows are stated in, or for a post without a table', () => {
    expect(unstatedWriteDownReleases(build([building], {}, outside(0)), {}, outside(0))).toEqual([])
    const stated: FixedAssetNoteRows = { ByggnaderMark: { 'impairment.forsaljningar': 20_000 } }
    expect(unstatedWriteDownReleases(build([building], stated, outside(20_000.6)), stated, outside(20_000.6))).toEqual([])
    expect(unstatedWriteDownReleases(build([makeAsset()]), {}, outside(20_000))).toEqual([])
    expect(unstatedWriteDownReleases(build([building]), {}, undefined)).toEqual([])
  })
})

describe('alignCarryingWithBalanceSheet', () => {
  const tables = () => build([makeAsset({ acquisition_cost: 60_000.4 })])

  it('prints the balance sheet post\'s own figure for a table that ties to the post\'s accounts', () => {
    const aligned = alignCarryingWithBalanceSheet(tables(), () => 60_000.9, () => 60_001)
    expect(aligned[0].carrying).toBe(60_001)
  })

  it('judges the tie on the unrounded books, as the tie-out does: the rounding of the balance sheet does not undo it', () => {
    // 900 000,61 in the note and 900 001,60 on the accounts are within the
    // krona; the balance sheet prints 900 002, which is 1,39 from the note.
    const note = build([makeAsset({ category: 'land', bas_asset_account: '1130', acquisition_cost: 900_000.61, useful_life_months: 0 })])
    expect(alignCarryingWithBalanceSheet(note, () => 900_001.6, () => 900_002)[0].carrying).toBe(900_002)
  })

  it('keeps the note\'s own figure when it does not tie, or the post is not on the books or the balance sheet', () => {
    expect(alignCarryingWithBalanceSheet(tables(), () => 59_000, () => 59_000)[0].carrying).toBe(60_000.4)
    expect(alignCarryingWithBalanceSheet(tables(), () => undefined, () => 60_000)[0].carrying).toBe(60_000.4)
    expect(alignCarryingWithBalanceSheet(tables(), () => 60_000, () => undefined)[0].carrying).toBe(60_000.4)
  })

  it('keeps the figure of a table that is not the whole post: its write-downs are in the ledger note', () => {
    // The accounts hold 20 000 of write-downs the table could not take:
    // the table (60 000) is not the post (40 000), whatever the tie-out
    // subtracted before comparing.
    expect(alignCarryingWithBalanceSheet(tables(), () => 40_000.4, () => 40_000)[0].carrying).toBe(60_000.4)
  })
})

describe('fixedAssetNoteBody', () => {
  it('prints the rows as text, a reduction with a minus and a zero without one', () => {
    const body = plainSpaces(
      fixedAssetNoteBody(
        build([
          makeAsset({ acquisition_date: '2025-03-01', acquisition_cost: 30_000, figures: { ibAck: 0, aretsAvskrivning: 5_000, avgaendeAck: 0 } }),
        ]),
      ),
    )
    expect(body).toBe(
      [
        'Inventarier, verktyg och installationer',
        '  Ingående anskaffningsvärden: 0 kr',
        '  Inköp: 30 000 kr',
        '  Utgående anskaffningsvärden: 30 000 kr',
        '  Ingående avskrivningar: 0 kr',
        '  Årets avskrivningar: \u22125 000 kr',
        '  Utgående avskrivningar: \u22125 000 kr',
        '  Redovisat värde: 25 000 kr',
      ].join('\n'),
    )
  })

  it('prints a reversal inside a reducing block without a minus, and an increase that came in with one', () => {
    const body = plainSpaces(
      fixedAssetNoteBody(
        build([
          makeAsset({
            disposed_at: '2025-06-30',
            acquisition_cost: 40_000,
            figures: { ibAck: 8_000, aretsAvskrivning: 4_000, avgaendeAck: 12_000 },
          }),
          makeAsset({
            acquisition_date: '2025-05-01',
            acquisition_type: 'reclassification',
            acquisition_cost: 20_000,
            figures: { ibAck: 7_000, aretsAvskrivning: 0, avgaendeAck: 0 },
          }),
        ]),
      ),
    )
    expect(body).toContain('  Försäljningar/utrangeringar: 12 000 kr')
    expect(body).toContain('  Omklassificeringar: \u22127 000 kr')
    expect(body).toContain('  Årets avskrivningar: \u22124 000 kr')
  })
})

describe('fixedAssetNoteBody and the tagged table round alike', () => {
  it('prints a negative amount that ends in 50 öre a whole krona away from zero', () => {
    // 5 000,50 kr of avskrivningar came in with a reclassified asset: the row
    // is -5 000,50 and prints as -5 001 kr.
    const tables = build([
      makeAsset({
        acquisition_date: '2025-05-01',
        acquisition_type: 'reclassification',
        acquisition_cost: 20_000,
        figures: { ibAck: 5_000.5, aretsAvskrivning: 0, avgaendeAck: 0 },
      }),
    ])
    expect(amounts(tables[0])['depreciation.omklassificeringar']).toBe(-5_000.5)
    expect(plainSpaces(fixedAssetNoteBody(tables))).toContain('  Omklassificeringar: \u22125 001 kr')
  })
})

describe('figures in öre', () => {
  it('prints each figure as the rounding of its own amount, so the redovisat värde stays the balance sheet post', () => {
    // The document tags every figure to the krona (decimals 0): a row is the
    // rounding of its own amount, never an amount adjusted to make a column
    // add up. Four purchases of 10,49 on an opening of 100,49 therefore print
    // as 100 + 4 x 10 and a closing of 142 (142,45): the two kronor are
    // rounding, and the closing is the figure the balance sheet holds.
    const tables = build([
      makeAsset({ acquisition_cost: 100.49 }),
      ...[1, 2, 3, 4].map(() => makeAsset({ acquisition_date: '2025-02-01', acquisition_cost: 10.49 })),
    ])
    expect(amounts(tables[0])).toEqual({ 'cost.opening': 100.49, 'cost.inkop': 41.96, 'cost.closing': 142.45 })
    expect(plainSpaces(fixedAssetNoteBody(tables))).toBe(
      [
        'Inventarier, verktyg och installationer',
        '  Ingående anskaffningsvärden: 100 kr',
        '  Inköp: 42 kr',
        '  Utgående anskaffningsvärden: 142 kr',
        '  Redovisat värde: 142 kr',
      ].join('\n'),
    )
  })
})

describe('normalizeFixedAssetNoteRows and statedRowIssue', () => {
  it('keeps known posts and rows with an amount, in whole kronor', () => {
    expect(
      normalizeFixedAssetNoteRows({
        MaskinerAndraTekniskaAnlaggningar: { 'cost.omrakningsdifferenser': 1_000.4, 'impairment.fusion': 0 },
        ByggnaderMark: { 'depreciation.omrakningsdifferenser': -250.5, 'impairment.forsaljningar': 9_000 },
      }),
    ).toEqual({
      MaskinerAndraTekniskaAnlaggningar: { 'cost.omrakningsdifferenser': 1_000 },
      ByggnaderMark: { 'depreciation.omrakningsdifferenser': -251, 'impairment.forsaljningar': 9_000 },
    })
  })

  it('drops what is not a post, not a stated row, not a number, or an amount its row cannot carry', () => {
    expect(
      normalizeFixedAssetNoteRows({
        AndelarKoncernforetag: { 'cost.omrakningsdifferenser': 1 },
        Goodwill: { 'cost.fusion': 5, 'cost.inkop': 5, 'impairment.fusion': -5, 'impairment.forsaljningar': -5, 'impairment.omklassificeringar': 'x' },
        ByggnaderMark: null,
      }),
    ).toEqual({})
    expect(normalizeFixedAssetNoteRows(null)).toEqual({})
    expect(normalizeFixedAssetNoteRows([])).toEqual({})
  })

  it('refuses a negative amount only on a row whose standard label names one direction', () => {
    expect(statedRowIssue('impairment.fusion', -1)).toContain('positivt belopp')
    expect(statedRowIssue('impairment.fusion', 1)).toBeNull()
    expect(statedRowIssue('impairment.forsaljningar', -1)).toContain('positivt belopp')
    expect(statedRowIssue('impairment.forsaljningar', 1)).toBeNull()
    expect(statedRowIssue('impairment.omklassificeringar', -1)).toBeNull()
    expect(statedRowIssue('impairment.omrakningsdifferenser', -1)).toBeNull()
    expect(statedRowIssue('cost.omrakningsdifferenser', -1)).toBeNull()
    expect(statedRowIssue('depreciation.omrakningsdifferenser', -1)).toBeNull()
  })

  it('refuses an amount that is not in whole kronor', () => {
    expect(statedRowIssue('cost.omrakningsdifferenser', 100.5)).toBe('Ange beloppet i hela kronor.')
    expect(statedRowIssue('cost.omrakningsdifferenser', -100)).toBeNull()
  })
})

describe('mergeFixedAssetNoteRows', () => {
  const stored: FixedAssetNoteRows = {
    ByggnaderMark: { 'cost.omrakningsdifferenser': 100_000, 'impairment.fusion': 50_000 },
    InventarierVerktygInstallationer: { 'depreciation.omrakningsdifferenser': 20_000 },
  }

  it('changes only the rows sent: the rest of the post stays', () => {
    expect(mergeFixedAssetNoteRows(stored, { ByggnaderMark: { 'cost.omrakningsdifferenser': 250_000 } })).toEqual({
      ByggnaderMark: { 'cost.omrakningsdifferenser': 250_000, 'impairment.fusion': 50_000 },
      InventarierVerktygInstallationer: { 'depreciation.omrakningsdifferenser': 20_000 },
    })
  })

  it('removes one row on null and keeps the others of the post', () => {
    expect(mergeFixedAssetNoteRows(stored, { ByggnaderMark: { 'impairment.fusion': null } })).toEqual({
      ByggnaderMark: { 'cost.omrakningsdifferenser': 100_000 },
      InventarierVerktygInstallationer: { 'depreciation.omrakningsdifferenser': 20_000 },
    })
  })

  it('removes a row stated as zero, and the post with its last row', () => {
    expect(mergeFixedAssetNoteRows(stored, { InventarierVerktygInstallationer: { 'depreciation.omrakningsdifferenser': 0 } })).toEqual({
      ByggnaderMark: { 'cost.omrakningsdifferenser': 100_000, 'impairment.fusion': 50_000 },
    })
  })

  it('removes a post on null, everything on a top-level null, and adds a new post', () => {
    expect(mergeFixedAssetNoteRows(stored, { ByggnaderMark: null, Goodwill: { 'impairment.omklassificeringar': -5_000 } })).toEqual({
      InventarierVerktygInstallationer: { 'depreciation.omrakningsdifferenser': 20_000 },
      Goodwill: { 'impairment.omklassificeringar': -5_000 },
    })
    expect(mergeFixedAssetNoteRows(stored, null)).toEqual({})
  })

  it('starts from nothing when nothing usable is stored', () => {
    expect(mergeFixedAssetNoteRows(undefined, { ByggnaderMark: { 'cost.omrakningsdifferenser': 1 } })).toEqual({
      ByggnaderMark: { 'cost.omrakningsdifferenser': 1 },
    })
    expect(mergeFixedAssetNoteRows('nonsense', {})).toEqual({})
  })
})
