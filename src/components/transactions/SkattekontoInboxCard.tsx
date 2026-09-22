'use client'

import { useRef } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { TD_CLASS, CHECKBOX_REVEAL_CLASS } from '@/components/ui/dry-table'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import type { TxColumnId } from '@/lib/transactions/columns-v2'
import { HUE_DOT_CLASS, accountHue } from '@/lib/bookkeeping/template-group-colors'
import { AlertCircle, Link2, Loader2, MoreHorizontal } from 'lucide-react'
import type {
  SkattekontoBookingSuggestion,
  SkattekontoMatchSuggestion,
  StoredSkattekontoTransaction,
} from '@/types/skatteverket'

/**
 * Skattekonto-rad in the /transactions inbox, rendered as a dry-table row
 * (concept scene 10) with the same columns as a bank row, although it is
 * fundamentally different from a bank tx: different counter-account (1630 vs
 * 1930), different categorization rules. The Kategori cell shows what Bokför
 * will do (the rule's account), the Konto cell names the source, and the
 * actions are one button plus a menu, so the row reads like its neighbours
 * instead of a special case. No foldout.
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
  columns,
  accountLabel = null,
  accountLogo = null,
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
  /** The visible columns (lib/transactions/columns-v2). */
  columns: ReadonlySet<TxColumnId>
  /** Text for the Konto cell (the source account). */
  accountLabel?: string | null
  /** The Skatteverket mark for the Konto cell. */
  accountLogo?: string | null
}) {
  const t = useTranslations('tx_skattekonto_card')
  // See TransactionInboxCard: onCheckedChange has no event, so shift is
  // captured from the preceding click.
  const shiftHeld = useRef(false)
  const amount = Number(row.belopp_skatteverket)
  const isIncome = amount > 0
  const show = (c: TxColumnId) => columns.has(c)
  const suggestionLabel = bookingSuggestion
    ? bookingSuggestion.account_name || bookingSuggestion.label || bookingSuggestion.account
    : null

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
      data-tx-id={row.id}
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
      {/* Always-visible selection checkbox (concept .cb) in a real first
          column: the full-bleed panel has no margin for it to hang in. */}
      <td className={cn(TD_CLASS, 'select-none', 'w-7 !pl-0 !pr-2')}>
        {selectable && (
          <Checkbox
            checked={isSelected}
            onClick={(e) => {
              shiftHeld.current = e.shiftKey
            }}
            onCheckedChange={() => onToggleSelect?.(row.id, shiftHeld.current)}
            aria-label={t('select_row')}
            className={cn(
              'border-foreground duration-150',
              'block',
              isSelected ? 'opacity-100' : CHECKBOX_REVEAL_CLASS,
            )}
          />
        )}
      </td>
      {show('date') && (
        <td className={cn(TD_CLASS, '!pl-0 whitespace-nowrap tabular-nums text-muted-foreground')}>
          {formatDate(row.transaktionsdatum)}
        </td>
      )}
      {/* overflow-hidden: the shrink-0 chips below don't truncate, so on a
          viewport too narrow for them the cell must clip instead of painting
          over the Belopp column. Same guard #2003 put on TransactionInboxCard;
          this row and the ones below never got it. */}
      <td className={cn(TD_CLASS, 'max-w-0 w-full overflow-hidden')}>
        <span className="row-collapsible flex min-w-0 items-center gap-2">
          <span className="truncate">{row.transaktionstext}</span>
          {matchSuggestion && (
            <Badge variant="warning" className="h-4 shrink-0 gap-1 px-1.5 py-0 text-[10px]">
              <AlertCircle className="h-3 w-3" />
              {duplicateLabel}
            </Badge>
          )}
        </span>
      </td>
      {columns.has('category') && (
        <td className={cn(TD_CLASS, 'whitespace-nowrap')}>
          {/* What Bokför will do; the dialog behind it is where the account changes. */}
          <button
            type="button"
            className={cn(
              'inline-flex max-w-[16rem] items-center gap-1.5 rounded-full border border-border px-2.5 py-0.5 text-xs transition-colors duration-150',
              suggestionLabel ? 'text-foreground hover:bg-secondary/60' : 'text-muted-foreground hover:text-foreground',
            )}
            onClick={() => onBokfor(row)}
            disabled={processing}
          >
            {suggestionLabel && bookingSuggestion && (
              <span className={cn('h-2 w-2 shrink-0 rounded-full', HUE_DOT_CLASS[accountHue(bookingSuggestion.account)])} aria-hidden />
            )}
            <span className="truncate">{suggestionLabel ?? t('category_pick')}</span>
          </button>
        </td>
      )}
      {columns.has('account') && (
        <td className={cn(TD_CLASS, 'whitespace-nowrap text-muted-foreground')}>
          <span className="inline-flex items-center gap-2">
            {accountLogo && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={accountLogo} alt="" className="h-4 w-4 shrink-0 rounded-sm object-contain" />
            )}
            {accountLabel ?? ''}
          </span>
        </td>
      )}
      {show('amount') && (
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
      )}
      <td className={cn(TD_CLASS, 'whitespace-nowrap text-right !pr-0 py-[9px]')}>
        <span className="row-collapsible inline-flex items-center justify-end gap-2">
          {/* Likely duplicate: linking beats re-booking, so it leads. */}
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-3.5 text-xs"
            onClick={() => (matchSuggestion ? onMatch(row) : onBokfor(row))}
            disabled={processing}
          >
            {processing ? (
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            ) : matchSuggestion ? (
              <Link2 className="mr-1 h-3 w-3" />
            ) : null}
            {matchSuggestion ? t('link_to_voucher') : t('book')}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="mr-2 h-7 w-7 text-muted-foreground hover:text-foreground"
                aria-label={t('more_actions_aria')}
                title={t('more_actions_aria')}
                disabled={processing}
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {matchSuggestion ? (
                <DropdownMenuItem onClick={() => onBokfor(row)}>{t('book_anyway')}</DropdownMenuItem>
              ) : (
                <DropdownMenuItem onClick={() => onMatch(row)}>{t('match_to_voucher')}</DropdownMenuItem>
              )}
              {onIgnore && <DropdownMenuItem onClick={() => onIgnore(row)}>{t('ignore')}</DropdownMenuItem>}
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </td>
    </tr>
  )
}
