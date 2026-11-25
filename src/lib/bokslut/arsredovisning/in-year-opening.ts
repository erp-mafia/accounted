/**
 * An opening amount ("redan avskrivet per datum",
 * assets.opening_accumulated_depreciation) dated inside the year being
 * reported. The register counts it as on the books at the start of the year
 * (asset-note-figures.ts), but what the previous system or a hand booking
 * wrote off from the year's first day to the stated day went on the books
 * during the year: the note opened too high and showed too little as årets
 * avskrivningar (ÅRL 5 kap. 8 § första stycket 4), while its closing balance
 * was right. The ingående balans must be last year's utgående (ÅRL 2 kap. 4 §
 * första stycket 7), and the books say how much of the amount they held at
 * the start of the year.
 *
 * Per balance sheet post, on the post's accounts of accumulated av- och
 * nedskrivningar (isAccumulatedContraAccount):
 *
 *   gap   = the register's accumulated avskrivningar at the start of the year
 *           less the books'
 *   moved = gap, never below 0 and never more than the post's opening
 *           amounts dated inside the year
 *
 * moves from ingående to årets avskrivningar, and only when the post's
 * accumulated avskrivningar at the end of the year agree with the books
 * within the krona the tie-out allows. Per post, not per account: a previous
 * system that kept the depreciation on 1248/1249 while the register says 1229
 * still opens right. On the accumulated accounts, not on the post's value: a
 * cost booked during the year, or an asset or mark the register lacks, stays
 * the difference the tie-out reports instead of becoming avskrivningar. A
 * post with nedskrivningar, in the register or on the books, is left as it
 * is: its accumulated accounts hold more than avskrivningar.
 *
 * Where less than the gap moves, the outcome says why and the note keeps the
 * difference: the K2 note's tie-out reports it per post
 * (fixedAssetPostTieOut); the K3 note ties only its total, so
 * inYearOpeningWarnings names the post. Nothing is written to the books: the
 * figures are computed when the report is built, and a version locked for
 * signing renders from its stored copy.
 */
import { roundOre } from '@/lib/money'
import { isAccumulatedContraAccount } from '@/lib/bookkeeping/bas-data/accumulated-contra-accounts'
import { depreciationStartOf } from '@/lib/bokslut/assets/asset-units'
import { activeComponentsOf } from '@/lib/bokslut/assets/component-depreciation'
import { openingDepreciationOf } from '@/lib/bokslut/assets/depreciation-engine'
import { addDaysIso, addMonthsIso, earlierIso, laterIso, monthsBetween } from '@/lib/bokslut/assets/plan-calendar'
import { allocateByWeight } from '@/lib/bokslut/assets/value-adjustment-service'
import { writeDownMovement } from '@/lib/bokslut/assets/value-adjustments'
import type { Asset, TrialBalanceRow } from '@/types'
import type { AssetDepreciationFigures } from './asset-note-figures'
import { tangibleImpairmentBalance } from './ledger-fixed-asset-notes'
import { formatPdfKronor } from './pdf-format'

type LedgerRow = Pick<
  TrialBalanceRow,
  'account_number' | 'account_name' | 'opening_debit' | 'opening_credit' | 'period_debit' | 'period_credit' | 'closing_debit' | 'closing_credit'
>

interface Period {
  period_start: string
  period_end: string
}

/** A post's figures may differ from its books by a krona (fixedAssetPostTieOut). */
const KRONA = 1

export interface InYearOpeningOutcome {
  /** The balance sheet post. */
  post: string
  /** The post's opening amounts dated inside the year: the most that can move. */
  inYear: number
  /** The register's accumulated avskrivningar on the post at the start of the year, before the move. */
  registerAtStart: number
  /** The books' accumulated av- och nedskrivningar on the post at the start of the year. */
  booksAtStart: number
  /** Moved from ingående to årets avskrivningar. */
  moved: number
  /**
   * 'moved': the post now opens as the books do. 'clamped': the gap was below
   * 0 or above the in-year amounts, so a difference is left. Nothing moved
   * on 'closing-not-tied' (the year's end does not agree with the books) or
   * 'write-downs' (the post holds nedskrivningar).
   */
  reason: 'moved' | 'clamped' | 'closing-not-tied' | 'write-downs'
}

/**
 * The part of an asset's opening amount the note counts as on the books at
 * the start of the year although it is dated inside the year. 0 for an asset
 * that came in during the year (its opening amount is on the year's rows
 * already) and for one dated before or after the year. A component asset's
 * opening is its components' (the register keeps their sum, dated at the
 * latest): only the components dated inside the year count.
 */
export function openingDatedInYear(asset: Asset, period: Period): number {
  if (asset.acquisition_date >= period.period_start) return 0
  if (asset.disposed_at && asset.disposed_at < period.period_start) return 0
  const opening = openingDepreciationOf(asset)
  // The note counts the opening from the year its date falls in.
  if (!opening || opening.date < period.period_start || opening.date > period.period_end) return 0
  const stated = activeComponentsOf(asset).filter((component) => component.opening !== null)
  if (stated.length === 0) return opening.amount
  const inYear = stated.reduce(
    (sum, component) => (component.opening!.date >= period.period_start ? sum + component.opening!.amount : sum),
    0,
  )
  return Math.min(opening.amount, roundOre(inYear))
}

/**
 * What a straight-line plan writes off on the asset from the start of the
 * year to its stated day, at most the in-year part: how a post's moved amount
 * is shared between its assets. Only a weight: the note is per post, and only
 * a note that groups otherwise (K3, per category) sees the shares.
 */
function inYearWeight(asset: Asset, period: Period, inYear: number): number {
  const opening = openingDepreciationOf(asset)
  const life = Number(asset.useful_life_months)
  const base = Number(asset.acquisition_cost) - Number(asset.salvage_value || 0)
  if (!opening || !(life > 0) || !(base > 0)) return 0
  const start = depreciationStartOf(asset)
  const months = monthsBetween(
    laterIso(period.period_start, start),
    earlierIso(addDaysIso(opening.date, 1), addMonthsIso(start, life)),
  )
  return Math.min(inYear, roundOre((base * months) / life))
}

/** `moved` over the post's in-year assets: first as their plans would have it, the rest by what each in-year part leaves room for. */
function shareOut(moved: number, items: ReadonlyArray<{ id: string; inYear: number; weight: number }>): Map<string, number> {
  const planned = roundOre(items.reduce((sum, item) => sum + item.weight, 0))
  const first = allocateByWeight(
    Math.min(moved, planned),
    items.map((item) => ({ key: item.id, weight: item.weight, cap: item.weight })),
  )
  const given = roundOre([...first.values()].reduce((sum, amount) => sum + amount, 0))
  const rest = allocateByWeight(
    roundOre(moved - given),
    items.map((item) => {
      const room = roundOre(item.inYear - (first.get(item.id) ?? 0))
      return { key: item.id, weight: room, cap: room }
    }),
  )
  const shares = new Map<string, number>()
  for (const item of items) {
    const share = roundOre((first.get(item.id) ?? 0) + (rest.get(item.id) ?? 0))
    if (share !== 0) shares.set(item.id, share)
  }
  return shares
}

/** A post's accumulated av- och nedskrivningar on the books, as a positive amount. */
function accumulatedOnBooks(rows: readonly LedgerRow[], at: 'opening' | 'closing'): number {
  return -roundOre(
    rows
      .filter((row) => isAccumulatedContraAccount(row.account_number))
      .reduce(
        (sum, row) =>
          sum + (at === 'opening'
            ? (row.opening_debit || 0) - (row.opening_credit || 0)
            : (row.closing_debit || 0) - (row.closing_credit || 0)),
        0,
      ),
  )
}

/**
 * The note's figures with each post's in-year opening amounts moved to the
 * year where the books hold them there (see the module comment), and what
 * happened per post that holds such an amount.
 */
export function moveInYearOpenings(params: {
  /** The assets as the note reads them for the year (noteAsset). */
  assets: readonly Asset[]
  figures: ReadonlyMap<string, AssetDepreciationFigures>
  period: Period
  /** The balance sheet post of a BAS account, null when none covers it. */
  postOfAccount: (account: string) => string | null
  /** The year's full trial balance: opening balances included. */
  rows: readonly LedgerRow[]
}): { figures: Map<string, AssetDepreciationFigures>; outcomes: InYearOpeningOutcome[] } {
  const { period, postOfAccount } = params
  const figures = new Map(params.figures)
  const outcomes: InYearOpeningOutcome[] = []

  const assetsByPost = new Map<string, Asset[]>()
  for (const asset of params.assets) {
    const post = asset.bas_asset_account ? postOfAccount(asset.bas_asset_account) : null
    if (!post) continue
    assetsByPost.set(post, [...(assetsByPost.get(post) ?? []), asset])
  }

  for (const [post, assets] of assetsByPost) {
    const inYear = assets
      .map((asset) => ({ asset, amount: openingDatedInYear(asset, period) }))
      .filter((entry) => entry.amount > 0)
    if (inYear.length === 0) continue

    const figuresOf = (asset: Asset) => figures.get(asset.id) ?? { ibAck: 0, aretsAvskrivning: 0, avgaendeAck: 0 }
    // In the note for the year: not disposed before it, not bought after it.
    const inNote = assets.filter(
      (asset) => !(asset.disposed_at && asset.disposed_at < period.period_start) && asset.acquisition_date <= period.period_end,
    )
    const registerAtStart = roundOre(
      inNote.filter((asset) => asset.acquisition_date < period.period_start).reduce((sum, asset) => sum + figuresOf(asset).ibAck, 0),
    )
    // What a new asset carried in is in its ibAck too, and on the books at the end.
    const registerAtEnd = roundOre(
      inNote.reduce((sum, asset) => {
        const f = figuresOf(asset)
        return sum + f.ibAck + f.aretsAvskrivning - f.avgaendeAck
      }, 0),
    )
    const rows = params.rows.filter((row) => postOfAccount(row.account_number) === post)
    const outcome: InYearOpeningOutcome = {
      post,
      inYear: roundOre(inYear.reduce((sum, entry) => sum + entry.amount, 0)),
      registerAtStart,
      booksAtStart: accumulatedOnBooks(rows, 'opening'),
      moved: 0,
      reason: 'moved',
    }
    outcomes.push(outcome)

    const writeDowns = inNote.some((asset) => {
      const movement = writeDownMovement(asset, period.period_start, period.period_end)
      return [movement.opening, movement.writtenDown, movement.reversed, movement.disposed, movement.closing].some((amount) => amount !== 0)
    })
    if (writeDowns || tangibleImpairmentBalance(rows, new Map(), 'opening') !== 0 || tangibleImpairmentBalance(rows, new Map(), 'closing') !== 0) {
      outcome.reason = 'write-downs'
      continue
    }
    if (Math.abs(registerAtEnd - accumulatedOnBooks(rows, 'closing')) > KRONA) {
      outcome.reason = 'closing-not-tied'
      continue
    }
    const gap = roundOre(registerAtStart - outcome.booksAtStart)
    outcome.moved = roundOre(Math.min(outcome.inYear, Math.max(0, gap)))
    if (Math.abs(gap - outcome.moved) >= 0.005) outcome.reason = 'clamped'
    if (outcome.moved <= 0) continue

    const shares = shareOut(
      outcome.moved,
      inYear.map(({ asset, amount }) => ({ id: asset.id, inYear: amount, weight: inYearWeight(asset, period, amount) })),
    )
    for (const [id, share] of shares) {
      const current = figures.get(id)
      if (!current) continue
      figures.set(id, {
        ...current,
        ibAck: roundOre(current.ibAck - share),
        aretsAvskrivning: roundOre(current.aretsAvskrivning + share),
      })
    }
  }
  return { figures, outcomes }
}

/**
 * The K3 note ties only its total to the books, so a post whose in-year
 * opening amounts could not be placed as the books hold them is named here:
 * its ingående and årets avskrivningar are off by the difference. The K2 note
 * reports the same per post in its tie-out (fixedAssetPostTieOut).
 */
export function inYearOpeningWarnings(
  outcomes: readonly InYearOpeningOutcome[],
  labelOfPost: (post: string) => string,
): string[] {
  const warnings: string[] = []
  for (const outcome of outcomes) {
    const label = labelOfPost(outcome.post)
    if (outcome.reason === 'write-downs') {
      warnings.push(
        `Anläggningsnoten för ${label}: redan avskrivet belopp på ${formatPdfKronor(outcome.inYear)} kr är angivet per ett datum inne i året. Posten har nedskrivningar, så noten kan inte stämma av beloppet mot bokföringen och räknar det i sin helhet som ingående avskrivningar. Den del som bokfördes under året hör till årets avskrivningar: kontrollera postens ingående och årets avskrivningar mot bokföringen.`,
      )
      continue
    }
    const opening = roundOre(outcome.registerAtStart - outcome.moved)
    if (Math.abs(opening - outcome.booksAtStart) <= KRONA) continue
    warnings.push(
      `Anläggningsnoten för ${label}: ackumulerade avskrivningar vid årets ingång (${formatPdfKronor(opening)} kr) stämmer inte med postens bokförda (${formatPdfKronor(outcome.booksAtStart)} kr). Redan avskrivet belopp är angivet per ett datum inne i året för tillgångar i posten, och årets avskrivningar i noten blir då fel med skillnaden. Kontrollera att tillgångarna ligger på postens konton, att redan avskrivet belopp är det som var bokfört det datumet och att årets avskrivningar är bokförda.`,
    )
  }
  return warnings
}
