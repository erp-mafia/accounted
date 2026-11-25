/**
 * The BAS 2026 accounts a nedskrivning books on (ÅRL 4:5, K3 27): the 12x8
 * beside the asset's accumulated-depreciation account and the 77xx by
 * category. Server side: it reads the BAS reference.
 */
import { computeSRUCode } from '@/lib/bookkeeping/bas-data/sru-mapping'
import { isStandardBASAccount } from '@/lib/bookkeeping/bas-reference'
import type { Asset, AssetCategory } from '@/types'

export interface ImpairmentAccounts {
  /** Ackumulerade nedskrivningar (12x8). */
  accumulated: string
  /** Nedskrivningar (77x0-77x3). */
  expense: string
  /** Återföring av nedskrivningar (776x-778x). */
  reversal: string
}

/** BAS 2026 77xx by category: nedskrivning and its återföring. */
const IMPAIRMENT_RESULT_ACCOUNTS: Record<AssetCategory, { expense: string; reversal: string }> = {
  immaterial: { expense: '7710', reversal: '7760' },
  building: { expense: '7720', reversal: '7770' },
  land: { expense: '7720', reversal: '7770' },
  land_improvement: { expense: '7720', reversal: '7770' },
  machinery: { expense: '7731', reversal: '7781' },
  equipment: { expense: '7732', reversal: '7782' },
  vehicle: { expense: '7732', reversal: '7782' },
  computer: { expense: '7732', reversal: '7782' },
  other_tangible: { expense: '7733', reversal: '7783' },
}

/**
 * The 12x8 an asset is written down on when its own accumulated account
 * has no BAS sibling, by category. Mark has no accumulated-impairment
 * account of its own in BAS 2026: 1118 sits in the same balance-sheet post
 * (Byggnader och mark), so the balance sheet stays right.
 */
const CATEGORY_IMPAIRMENT_ACCOUNT: Record<AssetCategory, string> = {
  immaterial: '1098',
  building: '1118',
  land: '1118',
  land_improvement: '1158',
  machinery: '1218',
  equipment: '1228',
  vehicle: '1228',
  computer: '1228',
  other_tangible: '1298',
}

/**
 * The accounts a write-down of this asset books on: the BAS sibling of its
 * accumulated-depreciation account (12x9 -> 12x8: 1119 -> 1118, 1229 ->
 * 1228, 1019 -> 1018), else the category's 12x8 when it sits in the same
 * balance-sheet post, else the sibling as a company account
 * (ensureCompanyImpairmentAccount): BAS 2026 has no 1128 beside 1129, and
 * 1118 is Byggnader och mark, not Förbättringsutgifter på annans fastighet.
 * The 77xx by category.
 */
export function impairmentAccountsFor(
  asset: Pick<Asset, 'category' | 'bas_accumulated_account'>,
): ImpairmentAccounts {
  const result = IMPAIRMENT_RESULT_ACCOUNTS[asset.category]
  const own = asset.bas_accumulated_account
  let accumulated = CATEGORY_IMPAIRMENT_ACCOUNT[asset.category]
  if (own.endsWith('8')) {
    accumulated = own
  } else if (own.endsWith('9')) {
    const sibling = `${own.slice(0, -1)}8`
    if (isStandardBASAccount(sibling) || computeSRUCode(accumulated) !== computeSRUCode(own)) accumulated = sibling
  }
  return { accumulated, expense: result.expense, reversal: result.reversal }
}

/** BAS 1070-1079: goodwill, whose write-down is never reversed (ÅRL 4:5 tredje stycket). */
export function isGoodwill(asset: Pick<Asset, 'bas_asset_account'>): boolean {
  return asset.bas_asset_account >= '1070' && asset.bas_asset_account <= '1079'
}
