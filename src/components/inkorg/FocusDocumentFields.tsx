'use client'

import { useTranslations } from 'next-intl'
import { Skeleton } from '@/components/ui/skeleton'
import type { DocumentReading } from '@/lib/documents/reading/types'
import { DocumentFieldsPanel } from './DocumentFieldsPanel'

export interface FocusDocumentFieldsProps {
  /** The inbox item in focus. */
  itemId: string
  /** The one reading (GET /items/:id?include=reading); null until it answered or when it failed. */
  reading: DocumentReading | null
  loading: boolean
  failed: boolean
  /** Converted to a supplier invoice: the reading is frozen and nothing is editable. */
  locked?: boolean
  /** The reading changed (a person corrected a field): the focus view reads the item again. */
  onChanged?: () => void
}

/**
 * The slot under "Uppgifter från dokumentet": the field panel
 * (./DocumentFieldsPanel.tsx: where each value came from, its evidence
 * level, corrections in place), with the focus view's loading and failure
 * states around it. Already inside the fold, which carries the heading, so
 * the panel shows its list only.
 */
export function FocusDocumentFields({ itemId, reading, loading, failed, locked = false, onChanged }: FocusDocumentFieldsProps) {
  const t = useTranslations('inkorg')

  if (loading) {
    return (
      <div className="space-y-2" aria-busy="true">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-4 w-full rounded-sm" />
        ))}
      </div>
    )
  }
  if (failed) return <p className="text-[12.5px] text-muted-foreground">{t('fields_failed')}</p>
  if (!reading) return <p className="text-[12.5px] text-muted-foreground">{t('fields_empty')}</p>

  return <DocumentFieldsPanel itemId={itemId} reading={reading} locked={locked} embedded onSaved={() => onChanged?.()} />
}
