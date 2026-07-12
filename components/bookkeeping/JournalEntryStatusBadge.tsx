'use client'

import { useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'
import type { JournalEntry } from '@/types'

type BadgeVariant = 'default' | 'secondary' | 'success' | 'warning' | 'destructive'

const statusVariants: Record<string, BadgeVariant> = {
  draft: 'secondary',
  posted: 'success',
  reversed: 'warning',
  cancelled: 'secondary',
}

const sourceTypeVariants: Record<string, BadgeVariant> = {
  storno: 'destructive',
  correction: 'default',
}

const SOURCE_TYPES = [
  'manual',
  'bank_transaction',
  'invoice_created',
  'invoice_paid',
  'credit_note',
  'salary_payment',
  'opening_balance',
  'year_end',
  'storno',
  'correction',
  'import',
  'system',
  'supplier_invoice_registered',
  'supplier_invoice_paid',
  'supplier_invoice_cash_payment',
  'currency_revaluation',
  'reminder_fee',
  'vat_settlement',
] as const

/**
 * Hook returning the translated source-type label map. Use this in client
 * components that need to render the human-readable label for a source_type.
 */
export function useSourceTypeLabels(): Record<string, string> {
  const t = useTranslations('journal_status')
  const out: Record<string, string> = {}
  for (const key of SOURCE_TYPES) {
    out[key] = t(`source_label_${key}`)
  }
  return out
}

interface Props {
  entry: JournalEntry
  showStatus?: boolean
}

export default function JournalEntryStatusBadge({ entry, showStatus = true }: Props) {
  const t = useTranslations('journal_status')
  const statusVariant = statusVariants[entry.status]
  const sourceVariant = sourceTypeVariants[entry.source_type]

  const statusLabelKey =
    entry.status === 'draft' ? 'status_draft'
      : entry.status === 'posted' ? 'status_posted'
      : entry.status === 'reversed' ? 'status_reversed'
      : entry.status === 'cancelled' ? 'status_cancelled'
      : null

  const sourceLabelKey =
    entry.source_type === 'storno' ? 'source_storno'
      : entry.source_type === 'correction' ? 'source_correction'
      : null

  return (
    <span className="inline-flex items-center gap-1">
      {showStatus && statusVariant && statusLabelKey && (
        <Badge variant={statusVariant} className="text-[10px] px-1.5 py-0">
          {t(statusLabelKey)}
        </Badge>
      )}
      {sourceVariant && sourceLabelKey && (
        <Badge variant={sourceVariant} className="text-[10px] px-1.5 py-0">
          {t(sourceLabelKey)}
        </Badge>
      )}
    </span>
  )
}
