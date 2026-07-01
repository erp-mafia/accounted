'use client'

import { useTranslations } from 'next-intl'
import { motion } from 'framer-motion'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  DataListRow,
  DataListPrimary,
  DataListMeta,
  DataListMetaSeparator,
} from '@/components/ui/data-list'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { AlertCircle, ArrowUpRight, ArrowDownRight, Landmark, Link2, Loader2 } from 'lucide-react'
import type {
  SkattekontoMatchSuggestion,
  StoredSkattekontoTransaction,
} from '@/types/skatteverket'

/**
 * Skattekonto-rad in the /transactions inbox.
 *
 * Mirrors the visual rhythm of TransactionInboxCard. The Skatteverket badge is
 * the cue that this row is fundamentally different from a bank tx — different
 * counter-account (1630 vs 1930), different categorization rules.
 */
export default function SkattekontoInboxCard({
  row,
  matchSuggestion,
  processing,
  onBokfor,
  onMatch,
  onAnimationComplete,
}: {
  row: StoredSkattekontoTransaction
  matchSuggestion?: SkattekontoMatchSuggestion | null
  processing: boolean
  onBokfor: (row: StoredSkattekontoTransaction) => void
  onMatch: (row: StoredSkattekontoTransaction) => void
  onAnimationComplete?: (id: string) => void
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
    <motion.div
      layout
      initial={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.97, x: -16 }}
      transition={{ duration: 0.25, ease: [0.25, 0.46, 0.45, 0.94] }}
      onAnimationComplete={(definition) => {
        if (typeof definition === 'object' && 'opacity' in definition && definition.opacity === 0) {
          onAnimationComplete?.(row.id)
        }
      }}
    >
      <DataListRow
        leading={
          <span
            className={cn(
              'inline-flex h-5 w-5 items-center justify-center',
              isIncome ? 'text-success' : 'text-foreground/60'
            )}
            aria-hidden
          >
            {isIncome ? (
              <ArrowUpRight className="h-4 w-4" />
            ) : (
              <ArrowDownRight className="h-4 w-4" />
            )}
          </span>
        }
        trailing={
          <>
            <div className="text-right">
              <p
                className={cn(
                  'font-medium tabular-nums leading-none',
                  isIncome && 'text-success'
                )}
              >
                {isIncome ? '+' : ''}
                {formatCurrency(amount)}
              </p>
            </div>
            {matchSuggestion ? (
              <>
                <Button
                  size="sm"
                  variant="default"
                  className="h-8 px-3 text-xs"
                  onClick={() => onMatch(row)}
                  disabled={processing}
                >
                  <Link2 className="mr-1 h-3 w-3" />
                  {t('link_to_voucher')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 px-3 text-xs"
                  onClick={() => onBokfor(row)}
                  disabled={processing}
                >
                  {processing && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                  {t('book_anyway')}
                </Button>
              </>
            ) : (
              <>
                <Button
                  size="sm"
                  variant="default"
                  className="h-8 px-3 text-xs"
                  onClick={() => onBokfor(row)}
                  disabled={processing}
                >
                  {processing && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                  {t('book')}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 px-3 text-xs"
                  onClick={() => onMatch(row)}
                  disabled={processing}
                >
                  <Link2 className="mr-1 h-3 w-3" />
                  {t('match_to_voucher')}
                </Button>
              </>
            )}
          </>
        }
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <DataListPrimary>{row.transaktionstext}</DataListPrimary>
        </div>
        <DataListMeta>
          <span className="tabular-nums">{formatDate(row.transaktionsdatum)}</span>
          <DataListMetaSeparator />
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            <Landmark className="h-3 w-3" />
            {t('skv_badge')}
          </span>
          {matchSuggestion && (
            <>
              <DataListMetaSeparator />
              <Badge variant="warning" className="h-4 gap-1 px-1.5 py-0 text-[10px]">
                <AlertCircle className="h-3 w-3" />
                {duplicateLabel}
              </Badge>
            </>
          )}
        </DataListMeta>
      </DataListRow>
    </motion.div>
  )
}
