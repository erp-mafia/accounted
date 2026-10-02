import { roundOre } from '@/lib/money'
import { carriesObjectBalances, type ObjectBalanceSplit } from '@/lib/bookkeeping/dimension-carry'
import { makeNotice, type ImportNotice } from './notices'
import type { SIEObjectBalance } from './types'

export { splitBalanceLines, type ObjectBalanceSplit } from '@/lib/bookkeeping/dimension-carry'

/**
 * Object-level opening balances from SIE #OIB / #OUB (issue #3313).
 *
 * The IB verifikat is where a project's opening balance lives: each
 * balance-sheet account's IB is split into one line per object of an
 * accumulating dimension (bag {"6": "<code>"}) plus one untagged remainder
 * line for the part of the balance no object claims. The account total never
 * changes, so every reader of the IB entry that ignores tags (balance sheet,
 * unfiltered trial balance, #IB export, continuity) sees exactly what it saw
 * before. A dimension-filtered ledger picks the tagged lines up by the same
 * `dimensions @>` containment it applies to the year's lines.
 *
 * Pure helpers only (no I/O): the SIE parser uses them for the preview, the
 * direct and the job import paths for the IB entry, the resync path for the
 * next year's IB.
 */

/**
 * The SIE convention (projekt, dimension 6, accumulates; everything else
 * resets), for the preview, which has no company registry to read. The
 * import reads `dimensions.resets_annually` (lib/bookkeeping/dimension-carry).
 */
export { DEFAULT_ACCUMULATING_DIMENSIONS as SIE_DEFAULT_ACCUMULATING_DIMENSIONS } from '@/lib/bookkeeping/dimension-carry'

/** dimension_values.code DB CHECK: 1-40 chars, none of `"{}`. */
export function isValidRegistryCode(code: string): boolean {
  return code.length >= 1 && code.length <= 40 && !/["{}]/.test(code)
}

function isBalanceSheetAccountNumber(account: string): boolean {
  const first = account.charAt(0)
  return first === '1' || first === '2'
}

export type ObjectBalanceSkipReason =
  /** Class 3-8: result accounts close to equity and have no opening balance. */
  | 'result_account'
  /** 26xx: the VAT accounts' IB is never split per object (carriesObjectBalances). */
  | 'vat_account'
  /** The object's dimension resets annually (kostnadsställe, custom). */
  | 'resetting_dimension'
  /** The code cannot exist in the registry (length or `"{}`). */
  | 'invalid_code'
  /** The account also has rows on another accumulating dimension. */
  | 'second_dimension'


export interface ObjectBalancePlan {
  /** Source account number → the object parts to split off its balance. */
  byAccount: Map<string, ObjectBalanceSplit[]>
  /** Rows that became a split part. */
  applied: number
  skipped: Record<ObjectBalanceSkipReason, number>
  /**
   * Accounts that carried rows on more than one accumulating dimension. The
   * file gives each dimension's objects separately, never their joint
   * distribution, so the split uses one dimension (projekt when present) and
   * leaves the other untagged, with a warning.
   */
  multiDimensionAccounts: Array<{ account: string; usedDimNo: string; ignoredDimNos: string[] }>
}

/**
 * Decide which object rows split which account's balance. `rows` must
 * already be the rows for ONE year (see getEffectiveObjectOpeningBalances).
 * Duplicate rows for the same (account, dimension, code) are summed.
 */
export function planObjectBalances(
  rows: readonly SIEObjectBalance[],
  accumulating: ReadonlySet<string>
): ObjectBalancePlan {
  const skipped: Record<ObjectBalanceSkipReason, number> = {
    result_account: 0,
    vat_account: 0,
    resetting_dimension: 0,
    invalid_code: 0,
    second_dimension: 0,
  }

  // account → dimNo → code → { amount, rows }
  const candidates = new Map<string, Map<string, Map<string, { amount: number; rows: number }>>>()
  for (const row of rows) {
    if (!isBalanceSheetAccountNumber(row.account)) {
      skipped.result_account++
      continue
    }
    if (!carriesObjectBalances(row.account)) {
      skipped.vat_account++
      continue
    }
    if (!accumulating.has(row.dimNo)) {
      skipped.resetting_dimension++
      continue
    }
    if (!isValidRegistryCode(row.code)) {
      skipped.invalid_code++
      continue
    }
    const byDim = candidates.get(row.account) ?? new Map()
    const byCode = byDim.get(row.dimNo) ?? new Map()
    const existing = byCode.get(row.code) ?? { amount: 0, rows: 0 }
    existing.amount = roundOre(existing.amount + row.amount)
    existing.rows++
    byCode.set(row.code, existing)
    byDim.set(row.dimNo, byCode)
    candidates.set(row.account, byDim)
  }

  const byAccount = new Map<string, ObjectBalanceSplit[]>()
  const multiDimensionAccounts: ObjectBalancePlan['multiDimensionAccounts'] = []
  let applied = 0

  for (const [account, byDim] of candidates) {
    const dimNos = [...byDim.keys()].sort((a, b) => Number(a) - Number(b))
    const usedDimNo = dimNos.includes('6') ? '6' : dimNos[0]
    const ignored = dimNos.filter((dimNo) => dimNo !== usedDimNo)
    if (ignored.length > 0) {
      multiDimensionAccounts.push({ account, usedDimNo, ignoredDimNos: ignored })
      for (const dimNo of ignored) {
        for (const entry of byDim.get(dimNo)!.values()) skipped.second_dimension += entry.rows
      }
    }

    const parts: ObjectBalanceSplit[] = []
    for (const [code, entry] of byDim.get(usedDimNo)!) {
      applied += entry.rows
      if (entry.amount === 0) continue
      parts.push({ dimensions: { [usedDimNo]: code }, amount: entry.amount })
    }
    if (parts.length > 0) byAccount.set(account, parts)
  }

  return { byAccount, applied, skipped, multiDimensionAccounts }
}

/**
 * The preview's account of what the split will do, one info issue per
 * outcome and never silence (the file's #OIB rows used to be dropped with a
 * single "not supported" note). Messages are Swedish: preview surface.
 */
export function describeObjectBalancePlan(
  plan: ObjectBalancePlan,
  source: 'oib' | 'prior_oub' | 'oub'
): Array<{ severity: 'info' | 'warning'; message: string }> {
  const out: Array<{ severity: 'info' | 'warning'; message: string }> = []
  const label = source === 'oib' ? '#OIB' : source === 'prior_oub' ? '#OUB för föregående år' : '#OUB'
  if (plan.applied > 0) {
    out.push({
      severity: 'info',
      message:
        `${plan.applied} objektbalanser (${label}) fördelar den ingående balansen per projekt på ${plan.byAccount.size} konton: ` +
        'varje objekt får en egen IB-rad och resten av kontots IB bokförs utan objekt',
    })
  }
  if (plan.skipped.result_account > 0) {
    out.push({
      severity: 'info',
      message: `${plan.skipped.result_account} objektbalanser (${label}) på resultatkonton hoppas över: resultatkonton har ingen ingående balans`,
    })
  }
  if (plan.skipped.vat_account > 0) {
    out.push({
      severity: 'info',
      message:
        `${plan.skipped.vat_account} objektbalanser (${label}) på momskonton (26xx) hoppas över: ` +
        'momskontonas ingående balans fördelas inte per projekt utan bokförs utan objekt',
    })
  }
  if (plan.skipped.resetting_dimension > 0) {
    out.push({
      severity: 'info',
      message:
        `${plan.skipped.resetting_dimension} objektbalanser (${label}) på dimensioner som nollställs vid årsskiftet (till exempel kostnadsställe) hoppas över: ` +
        'bara dimensioner som ackumuleras över åren (projekt) förs vidare till IB',
    })
  }
  if (plan.skipped.invalid_code > 0) {
    out.push({
      severity: 'info',
      message: `${plan.skipped.invalid_code} objektbalanser (${label}) hoppas över: objektkoden är ogiltig (1-40 tecken, inte " { })`,
    })
  }
  for (const entry of plan.multiDimensionAccounts) {
    out.push({
      severity: 'warning',
      message:
        `Konto ${entry.account} har objektbalanser på flera dimensioner som förs vidare (${[entry.usedDimNo, ...entry.ignoredDimNos].join(', ')}): ` +
        `IB delas upp på dimension ${entry.usedDimNo}, övriga bokförs utan objekt`,
    })
  }
  return out
}

/**
 * Why an import booked its IB per account instead of split per project. The
 * per-account IB is what the file demands; the split is detail the import
 * ignored until #3313, so it never fails an import that used to pass.
 * - `registry`: the company's dimension registry refused an object (an
 *   archived project or dimension, with dimensions switched on).
 * - `line_limit`: the split IB is larger than one SIE job entry may be
 *   (2 000 lines or 1 MB, chunkSIEEntries), e.g. hundreds of projects on
 *   every balance-sheet account.
 */
export type OpeningBalanceSplitRefusal =
  | { reason: 'registry'; detail: string }
  | { reason: 'line_limit'; lines: number }

/** The import result's warning text (Swedish, as every import warning) and its sv/en notice. */
export function openingBalanceSplitRefusedNotice(
  refusal: OpeningBalanceSplitRefusal
): { text: string; notice: ImportNotice } {
  if (refusal.reason === 'registry') {
    return {
      text:
        'Ingående balans bokfördes utan fördelning per projekt: dimensionsregistret godtog inte alla objekt i filens objektbalanser ' +
        `(${refusal.detail}). Kontonas saldon är oförändrade.`,
      notice: makeNotice('sie_ib_project_split_refused', 'notice', { detail: refusal.detail }),
    }
  }
  return {
    text:
      `Ingående balans bokfördes utan fördelning per projekt: uppdelningen gav ${refusal.lines} rader och överskrider gränsen för en verifikation ` +
      '(2 000 rader eller 1 MB). Kontonas saldon är oförändrade.',
    notice: makeNotice('sie_ib_project_split_too_large', 'notice', { lines: refusal.lines }),
  }
}
