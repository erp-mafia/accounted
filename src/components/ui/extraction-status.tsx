'use client'

import { Loader2, Check, AlertCircle, FileWarning } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import type { ExtractionStatus } from '@/lib/hooks/use-document-extraction'

interface Props {
  status: ExtractionStatus
  elapsedMs?: number
  className?: string
}

// Inline status indicator for an AI extraction in flight. Sits next to a
// freshly-attached document in upload flows. Five visual states map to the
// useDocumentExtraction hook output. "disabled" renders nothing: the free
// tier has no AI extraction and shouldn't see scary UI.
//
// Copy is intentionally short. The status changes inline; the
// layout doesn't shift between states (icon + single line).
export default function ExtractionStatus({ status, elapsedMs = 0, className }: Props) {
  const t = useTranslations('extraction_status')
  if (status === 'idle' || status === 'disabled') return null

  const slow = elapsedMs > 8_000

  if (status === 'running') {
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1.5 text-xs text-muted-foreground',
          className,
        )}
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {slow ? t('running_slow') : t('running')}
      </span>
    )
  }

  if (status === 'succeeded') {
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1.5 text-xs text-success',
          className,
        )}
      >
        <Check className="h-3.5 w-3.5" />
        {t('succeeded')}
      </span>
    )
  }

  if (status === 'unsupported') {
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1.5 text-xs text-muted-foreground',
          className,
        )}
      >
        <FileWarning className="h-3.5 w-3.5" />
        {t('unsupported')}
      </span>
    )
  }

  // failed
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 text-xs text-warning',
        className,
      )}
    >
      <AlertCircle className="h-3.5 w-3.5" />
      {t('failed')}
    </span>
  )
}
