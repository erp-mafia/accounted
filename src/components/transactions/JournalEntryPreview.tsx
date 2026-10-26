'use client'

import { useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import { VoucherLinesTable } from '@/components/bookkeeping/VoucherLinesTable'
import { voucherLineView } from '@/lib/bookkeeping/voucher-line-view'
import type { ProposalLine } from '@/lib/bookkeeping/proposal-lines'

export interface JournalEntryPreviewProps {
  /** The lines the proposal books, from the server preview (useProposalPreview). */
  lines: ProposalLine[]
  /** The answer for the current proposal is on its way: `lines` are the last one. */
  loading?: boolean
  /** The booking's refusal of this proposal, in Swedish. */
  error?: string | null
  /** Accounts that were not in the previous proposal: their lines are marked so a change is seen, not inferred. */
  changedAccounts?: string[]
}

export default function JournalEntryPreview({ lines, loading = false, error = null, changedAccounts }: JournalEntryPreviewProps) {
  const t = useTranslations('tx_quick_review')

  if (error) {
    return (
      <div className="rounded-lg border bg-muted/30 px-3 py-2.5">
        <p className="text-xs font-medium text-muted-foreground mb-1.5">Verifikation</p>
        <p role="alert" className="text-sm text-destructive">{error}</p>
      </div>
    )
  }
  if (lines.length === 0) {
    return loading ? (
      <div className="rounded-lg border bg-muted/30 px-3 py-2.5" aria-busy="true">
        <p className="text-xs font-medium text-muted-foreground mb-1.5">Verifikation</p>
        <p className="text-sm text-muted-foreground">{t('preview_loading')}</p>
      </div>
    ) : null
  }

  return (
    <div
      className={cn('rounded-lg border bg-muted/30 px-3 py-2.5 overflow-hidden transition-opacity', loading && 'opacity-60')}
      aria-busy={loading}
    >
      <p className="text-xs font-medium text-muted-foreground mb-1.5">Verifikation</p>
      <VoucherLinesTable
        lines={lines.map((line) => ({
          ...voucherLineView(line),
          extra: changedAccounts?.includes(line.account) ? (
            <span className="rounded-sm bg-attn/15 px-1 text-[11px] font-medium uppercase tracking-wide text-attn">ny</span>
          ) : undefined,
        }))}
        withCurrency
      />
    </div>
  )
}
