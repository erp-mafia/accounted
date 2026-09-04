'use client'

import { useRef } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { TD_CLASS, QUIET_LINK_CLASS, CHECKBOX_REVEAL_CLASS } from '@/components/ui/dry-table'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { AlertCircle, Landmark, Link2, Loader2 } from 'lucide-react'
import type {
  SkattekontoBookingSuggestion,
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
  bookingSuggestion,
  isExiting = false,
  processing,
  selectable,
  isSelected,
  onToggleSelect,
  onBokfor,
  onMatch,
  onIgnore,
}: {
  row: StoredSkattekontoTransaction
  matchSuggestion?: SkattekontoMatchSuggestion | null
  bookingSuggestion?: SkattekontoBookingSuggestion | null
  /** The row was just booked and is animating out during the page's 350ms
   *  removal window (.row-exit collapse; instant under reduced motion). */
  isExiting?: boolean
  processing: boolean
  selectable?: boolean
  isSelected?: boolean
  onToggleSelect?: (id: string, extend?: boolean) => void
  onBokfor: (row: StoredSkattekontoTransaction) => void
  onMatch: (row: StoredSkattekontoTransaction) => void
  /** Optional "Ignorera" affordance: hides the row from the work list without
   *  booking it (skattekonto rows are never deleted). The parent owns the
   *  confirm dialog and the PATCH. */
  onIgnore?: (row: StoredSkattekontoTransaction) => void
}) {
  const t = useTranslations('tx_skattekonto_card')
  // See TransactionInboxCard: onCheckedChange has no event, so shift is
  // captured from the preceding click.
  const shiftHeld = useRef(false)
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
    <tr
      className={cn(
        'group transition-colors duration-150 hover:bg-secondary/35',
        isSelected && 'bg-secondary/40',
        isExiting && 'row-exit',
      )}
      // .row-exit only blocks pointer input; `inert` also drops keyboard
      // focus and activation (booking/matching controls) during the 350ms
      // removal window.
      inert={isExiting || undefined}
    >
      {/* Always-visible selection checkbox (concept .cb) */}
      {/* Zero-width cell: the checkbox hangs in the left page margin so
          the date column can sit flush with the page edge. */}
      <td className={cn(TD_CLASS, 'relative w-0 !p-0 select-none')}>
        {selectable && (
          <Checkbox
            checked={isSelected}
            onClick={(e) => {
              shiftHeld.current = e.shiftKey
            }}
            onCheckedChange={() => onToggleSelect?.(row.id, shiftHeld.current)}
            aria-label={t('select_row')}
            className={cn(
              'absolute -left-5 top-1/2 -translate-y-1/2 border-foreground duration-150 md:-left-6',
              isSelected ? 'opacity-100' : CHECKBOX_REVEAL_CLASS,
            )}
          />
        )}
      </td>
      <td className={cn(TD_CLASS, '!pl-0 whitespace-nowrap tabular-nums text-muted-foreground')}>
        {formatDate(row.transaktionsdatum)}
      </td>
      {/* overflow-hidden: the shrink-0 chips below don't truncate, so on a
          viewport too narrow for them the cell must clip instead of painting
          over the Belopp column. Same guard #2003 put on TransactionInboxCard;
          this row and the ones below never got it. */}
      <td className={cn(TD_CLASS, 'max-w-0 w-full overflow-hidden')}>
        <span className="row-collapsible flex min-w-0 items-center gap-2">
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
          {/* What "Bokför" will do: the deterministic rule match, muted so it
              reads as information, not state. Suppressed on likely duplicates
              where linking (not booking) is the recommended action. */}
          {bookingSuggestion && !matchSuggestion && (
            <span className="hidden shrink-0 whitespace-nowrap text-xs text-muted-foreground md:inline">
              {t('suggestion_line', {
                account: bookingSuggestion.account_name
                  ? `${bookingSuggestion.account} ${bookingSuggestion.account_name}`
                  : bookingSuggestion.account,
              })}
            </span>
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
        <span className="row-collapsible inline-flex items-center justify-end gap-3">
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
          {onIgnore && (
            <button
              type="button"
              className={QUIET_LINK_CLASS}
              onClick={() => onIgnore(row)}
              disabled={processing}
            >
              {t('ignore')}
            </button>
          )}
        </span>
      </td>
    </tr>
  )
}
