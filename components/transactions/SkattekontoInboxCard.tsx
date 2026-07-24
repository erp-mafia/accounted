'use client'

import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { TD_CLASS, QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { AlertCircle, Landmark, Link2, Loader2 } from 'lucide-react'
import type {
  SkattekontoMatchSuggestion,
  StoredSkattekontoTransaction,
} from '@/types/skatteverket'

/**
 * Skattekonto-rad in the /transactions inbox, rendered as a dry-table row
 * (concept scene 10). The Skatteverket chip is the cue that this row is
 * fundamentally different from a bank tx: different counter-account (1630 vs
 * 1930), different categorization rules. No foldout: both actions fit inline.
 */
export default function SkattekontoInboxCard({
  row,
  matchSuggestion,
  processing,
  onBokfor,
  onMatch,
}: {
  row: StoredSkattekontoTransaction
  matchSuggestion?: SkattekontoMatchSuggestion | null
  processing: boolean
  onBokfor: (row: StoredSkattekontoTransaction) => void
  onMatch: (row: StoredSkattekontoTransaction) => void
}) {
  const t = useTranslations('tx_skattekonto_card')
  const amount = Number(row.belopp_skatteverket)
  const isIncome = amount > 0

  const duplicateLabel =
    matchSuggestion?.voucher_series && matchSuggestion?.voucher_number
      ? t('duplicate_title_with_voucher', {
          label: formatVoucher({
            voucher_series: matchSuggestion.voucher_series,
            voucher_number: matchSuggestion.voucher_number,
          }),
        })
      : t('duplicate_title_draft')

  return (
    <tr className="group transition-colors duration-150 hover:bg-secondary/35">
      <td className={cn(TD_CLASS, 'w-0 !p-0')} aria-hidden="true"></td>
      <td className={cn(TD_CLASS, '!pl-0 whitespace-nowrap tabular-nums text-muted-foreground')}>
        {formatDate(row.transaktionsdatum)}
      </td>
      <td className={cn(TD_CLASS, 'max-w-0 w-full')}>
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{row.transaktionstext}</span>
          <Badge variant="outline" className="h-4 shrink-0 gap-1 px-1.5 py-0 text-[10px] font-normal">
            <Landmark className="h-3 w-3" />
            {t('skv_badge')}
          </Badge>
          {matchSuggestion && (
            <Badge variant="warning" className="h-4 shrink-0 gap-1 px-1.5 py-0 text-[10px]">
              <AlertCircle className="h-3 w-3" />
              {duplicateLabel}
            </Badge>
          )}
        </span>
      </td>
      <td
        className={cn(
          TD_CLASS,
          'whitespace-nowrap text-right tabular-nums rr-mask',
          isIncome && 'text-success',
        )}
      >
        {isIncome ? '+' : ''}
        {formatCurrency(amount)}
      </td>
      <td className={cn(TD_CLASS, 'whitespace-nowrap text-right !pr-0 py-[9px]')}>
        <span className="inline-flex items-center justify-end gap-3">
          {matchSuggestion ? (
            <>
              {/* Likely duplicate: linking beats re-booking, so it leads. */}
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-3.5 text-xs"
                onClick={() => onMatch(row)}
                disabled={processing}
              >
                <Link2 className="mr-1 h-3 w-3" />
                {t('link_to_voucher')}
              </Button>
              <button
                type="button"
                className={QUIET_LINK_CLASS}
                onClick={() => onBokfor(row)}
                disabled={processing}
              >
                {t('book_anyway')}
              </button>
            </>
          ) : (
            <>
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-3.5 text-xs"
                onClick={() => onBokfor(row)}
                disabled={processing}
              >
                {processing && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                {t('book')}
              </Button>
              <button
                type="button"
                className={QUIET_LINK_CLASS}
                onClick={() => onMatch(row)}
                disabled={processing}
              >
                {t('match_to_voucher')}
              </button>
            </>
          )}
        </span>
      </td>
    </tr>
  )
}
