import type { EligibilityBlock } from '@/lib/collections/eligibility'
import type { BannerCheckLine } from '@/lib/collections/overdue-banner'
import { formatKronor } from '@/lib/collections/amount-text'
import { formatDateTime } from '@/lib/utils'

/**
 * The one-line bank check and a failed requirement as the overdue banner and
 * the list's bulk dialog word them (collections namespace), so both read the
 * same.
 */

type Tp = (key: string, values?: Record<string, string | number>) => string

export function blockText(block: Pick<EligibilityBlock, 'code' | 'params'>, tp: Tp): string {
  return block.code === 'elig_below_minimum' ? tp(block.code, { amount: formatKronor(Number(block.params?.amount ?? 0)) }) : tp(block.code)
}

export function checkLineText(line: BannerCheckLine, tp: Tp): string {
  switch (line.key) {
    case 'banner_bank_clear':
      return line.date ? tp('banner_bank_clear_date', { date: formatDateTime(line.date) }) : tp('banner_bank_clear')
    case 'banner_bank_candidates':
      return tp('banner_bank_candidates', { count: line.count })
    case 'banner_bank_stale':
      return line.date ? tp('banner_bank_stale', { date: formatDateTime(line.date) }) : tp('banner_bank_stale_never')
    case 'banner_blocked':
      return blockText(line.block, tp)
    default:
      return tp(line.key)
  }
}
