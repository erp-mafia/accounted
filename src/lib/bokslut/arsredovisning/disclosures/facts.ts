/**
 * What the books say that a disclosure requirement needs to know: balances
 * at year end on a few BAS ranges, the kinds of equity movements of the year,
 * and the asset register. Pure: build-data collects the inputs.
 *
 * Extension point: a phase that can tell more from the books adds an
 * optional field here and sets it where the facts are collected (one call in
 * build-data.ts). A requirement that reads it treats a missing field as "not
 * known from the books" and asks the user instead. Planned:
 *   - P2: `developmentModel` (the recorded aktiverings- or
 *     kostnadsföringsmodell, K3 18.7), `deferredTax` (temporary differences,
 *     1370 included, K3 29), `components` and `impairments` figures,
 *     `transition` (first K3 year, K3 35).
 */
import type { TrialBalanceRow } from '@/types'
import type { EquityMovementKind } from '../equity-kinds'
import type { EquitySpecification, UnclassifiedEquityEntry } from '../equity-specification'

interface Range {
  start: string
  end: string
}

export interface DisclosureFacts {
  /** 1070-1079 at year end (debit-positive, kronor). */
  goodwill: number
  /** 1010-1019 at year end. */
  capitalizedDevelopment: number
  /** 1400-1469 and 1490-1499 at year end. */
  inventory: number
  /** Pågående arbeten: 1470-1479 (asset) and 2430-2439 (liability), absolute sum. */
  contractsInProgress: number
  /** 1360-1369 and 1685 at year end: loans to owners or närstående. */
  shareholderLoans: number
  /** Egna aktier (2094) held or moved during the year. */
  ownShares: boolean
  /** Deferred tax in the books: 1370-1379, 2240-2249, 8940-8949 (any balance or activity). */
  deferredTaxInBooks: { asset: number; liability: number; expense: number }
  /** Buildings or land improvements: 1110-1119, 1150-1159, or register categories building / land_improvement. */
  buildingAssets: boolean
  /** A register asset split into K3 components. */
  componentAssets: boolean
  /** Any finansiell anläggningstillgång (13xx) at the start or end of the year. */
  financialFixedAssets: boolean
  /** Immateriella or materiella anläggningstillgångar (1000-1299) in the ledger at the start or end of the year. */
  fixedAssetsInLedger: boolean
  /** The ÅRL 5:8 roll-forward note was printed from the asset register. */
  fixedAssetNoteFromRegister: boolean
  /** Fond för verkligt värde (2096) held or moved. */
  fairValueReserve: boolean
  /** Uppskrivningsfond (2085) changed during the year. */
  revaluationReserveChanged: boolean
  /** Kinds of equity movements of the year (equity-specification.ts). */
  equityKinds: readonly EquityMovementKind[]
  /** Equity verifikat the ledger could not classify. */
  equityUnclassified: readonly UnclassifiedEquityEntry[]
  /** Eget kapital below half the registered aktiekapital (ABL 25 kap. 13 §). */
  equityBelowHalfShareCapital: boolean
  /** The company is a publikt aktiebolag (profile answer, null unanswered). */
  publicCompany: boolean | null

  // ── Fed by later phases (absent until then) ──────────────────────────
  /** K3 18.7: the model the company chose for internally generated intangibles (P2). */
  developmentModel?: 'aktiveringsmodellen' | 'kostnadsforingsmodellen'
}

function inRanges(account: string, ranges: readonly Range[]): boolean {
  return ranges.some((range) => account >= range.start && account <= range.end)
}

type TbRow = Pick<TrialBalanceRow, 'account_number' | 'opening_debit' | 'opening_credit' | 'period_debit' | 'period_credit' | 'closing_debit' | 'closing_credit'>

function closingNet(rows: readonly TbRow[], ranges: readonly Range[]): number {
  return Math.round(
    rows
      .filter((row) => inRanges(row.account_number, ranges))
      .reduce((sum, row) => sum + (row.closing_debit || 0) - (row.closing_credit || 0), 0),
  )
}

function anyActivity(rows: readonly TbRow[], ranges: readonly Range[]): boolean {
  return rows.some(
    (row) =>
      inRanges(row.account_number, ranges)
      && [row.opening_debit, row.opening_credit, row.period_debit, row.period_credit, row.closing_debit, row.closing_credit].some(
        (amount) => Math.abs(amount || 0) >= 0.005,
      ),
  )
}

export interface CollectDisclosureFactsInput {
  /** The year's FULL trial balance. */
  tbFullRows: readonly TbRow[]
  assets: ReadonlyArray<{ category: string; disposed_at: string | null; k3_components?: unknown }>
  equitySpecification: EquitySpecification | undefined
  equityBelowHalfShareCapital: boolean
  publicCompany: boolean | null
  /** The roll-forward note on immateriella and materiella anläggningstillgångar was printed. */
  fixedAssetNoteFromRegister: boolean
}

const r = (start: string, end: string): Range => ({ start, end })

export function collectDisclosureFacts(input: CollectDisclosureFactsInput): DisclosureFacts {
  const rows = input.tbFullRows
  const spec = input.equitySpecification
  const post = (concept: string) => spec?.current.posts.find((p) => p.concept === concept)
  const revaluation = post('Uppskrivningsfond')
  const liveAssets = input.assets.filter((asset) => !asset.disposed_at)
  return {
    goodwill: closingNet(rows, [r('1070', '1079')]),
    capitalizedDevelopment: closingNet(rows, [r('1010', '1019')]),
    inventory: closingNet(rows, [r('1400', '1469'), r('1490', '1499')]),
    contractsInProgress:
      Math.abs(closingNet(rows, [r('1470', '1479')])) + Math.abs(closingNet(rows, [r('2430', '2439')])),
    shareholderLoans: closingNet(rows, [r('1360', '1369'), r('1685', '1685')]),
    ownShares: anyActivity(rows, [r('2094', '2094')]),
    deferredTaxInBooks: {
      asset: closingNet(rows, [r('1370', '1379')]),
      liability: -closingNet(rows, [r('2240', '2249')]),
      expense: anyActivity(rows, [r('8940', '8949')]) ? 1 : 0,
    },
    buildingAssets:
      anyActivity(rows, [r('1110', '1119'), r('1150', '1159')])
      || liveAssets.some((asset) => asset.category === 'building' || asset.category === 'land_improvement'),
    componentAssets: liveAssets.some((asset) => Array.isArray(asset.k3_components) && asset.k3_components.length > 0),
    financialFixedAssets: anyActivity(rows, [r('1300', '1399')]),
    fixedAssetsInLedger: rows.some(
      (row) =>
        row.account_number >= '1000'
        && row.account_number <= '1299'
        && (Math.abs((row.opening_debit || 0) - (row.opening_credit || 0)) >= 0.005
          || Math.abs((row.closing_debit || 0) - (row.closing_credit || 0)) >= 0.005),
    ),
    fixedAssetNoteFromRegister: input.fixedAssetNoteFromRegister,
    fairValueReserve: anyActivity(rows, [r('2096', '2096')]),
    revaluationReserveChanged: Boolean(revaluation) && revaluation!.opening !== revaluation!.closing,
    equityKinds: spec?.kinds ?? [],
    equityUnclassified: spec?.current.unclassified ?? [],
    equityBelowHalfShareCapital: input.equityBelowHalfShareCapital,
    publicCompany: input.publicCompany,
  }
}

/**
 * Signals in the books of temporary differences beyond obeskattade reserver
 * (K3 29), which the K3 document does not account for yet. Swedish, one per
 * signal:
 *   - booked: deferred tax is recorded (1370, 2240, 8940): the document
 *     cannot carry it, so the report fails closed
 *     (AR-K3-TEMPORARY-DIFFERENCES-UNSUPPORTED);
 *   - hints: assets that often carry temporary differences (buildings,
 *     component depreciation), shown with the profile question the user
 *     answers (has_other_temporary_differences).
 */
export function temporaryDifferenceSignals(
  facts: Pick<DisclosureFacts, 'deferredTaxInBooks' | 'buildingAssets' | 'componentAssets'>,
): { booked: string[]; hints: string[] } {
  const booked: string[] = []
  if (facts.deferredTaxInBooks.asset !== 0) booked.push('uppskjuten skattefordran är bokförd (konto 1370)')
  if (facts.deferredTaxInBooks.liability !== 0) booked.push('uppskjuten skatteskuld är bokförd (konto 2240)')
  if (facts.deferredTaxInBooks.expense !== 0) booked.push('uppskjuten skatt är bokförd i resultaträkningen (konto 8940)')
  const hints: string[] = []
  if (facts.buildingAssets) hints.push('företaget har byggnader eller markanläggningar')
  if (facts.componentAssets) hints.push('anläggningsregistret har tillgångar med komponentavskrivning')
  return { booked, hints }
}
