'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { DocumentTextIcon, ExclamationTriangleIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { DocumentPreview } from '@/components/bookkeeping/DocumentPreview'
import { documentPreviewKind } from '@/lib/documents/preview-kind'
import { fetchWithTimeout } from '@/lib/http/fetch-with-timeout'
import { cn } from '@/lib/utils'

// The same budget as the workspace's document read: one indexed lookup plus a sign call.
const DOCUMENT_FETCH_TIMEOUT_MS = 15_000

export interface DocumentMeta {
  url: string
  mime: string | null
}

type MetaState = { key: string; meta: DocumentMeta | null; failed: boolean }

/**
 * The item's document, read once per document and generation: its type
 * decides how it is shown, and the same-origin inline proxy is what the
 * browser loads (a signed Storage URL is served as an attachment, which a
 * browser refuses to frame).
 */
export function useDocumentMeta(documentId: string | null, generation = 0): {
  meta: DocumentMeta | null
  state: 'none' | 'loading' | 'ready' | 'error'
} {
  const key = documentId ? `${documentId}:${generation}` : null
  const [answer, setAnswer] = useState<MetaState | null>(null)

  useEffect(() => {
    if (!documentId || !key) return
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetchWithTimeout(
          `/api/documents/${documentId}`,
          { method: 'GET' },
          { timeoutMs: DOCUMENT_FETCH_TIMEOUT_MS, description: `document ${documentId}` },
        )
        if (!res.ok) throw new Error(String(res.status))
        const json = (await res.json()) as { data?: { mime_type?: string | null } }
        if (!cancelled) {
          setAnswer({ key, meta: { url: `/api/documents/${documentId}/inline`, mime: json.data?.mime_type ?? null }, failed: false })
        }
      } catch {
        if (!cancelled) setAnswer({ key, meta: null, failed: true })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [documentId, key])

  if (!key) return { meta: null, state: 'none' }
  if (!answer || answer.key !== key) return { meta: null, state: 'loading' }
  return answer.failed ? { meta: null, state: 'error' } : { meta: answer.meta, state: 'ready' }
}

/**
 * The document large: the preview the Underlag workspace shows
 * (components/bookkeeping/DocumentPreview), in the four states it can be
 * in. A failed read says the document could not be shown, never that there
 * is none: the row points at a stored document (BFL 7 kap).
 */
export function FocusDocumentPreview({
  meta,
  state,
  onRetry,
  className,
  paper = false,
}: {
  meta: DocumentMeta | null
  state: 'none' | 'loading' | 'ready' | 'error'
  onRetry: () => void
  className?: string
  /** A sheet of paper on the desk: white in both themes, lifted by the soft shadow token. */
  paper?: boolean
}) {
  const t = useTranslations('inbox_workspace')
  const tInk = useTranslations('inkorg')
  const frame = cn('flex w-full overflow-hidden rounded-lg border border-border bg-background', className)
  // Only a shown document is paper; the empty and failed states stay the page's own surface.
  const sheet = cn(frame, paper && 'bg-white shadow-[var(--shadow-lg)]')

  if (state === 'loading') return <Skeleton className={cn('w-full rounded-lg', className)} />
  if (state === 'none') {
    return (
      <div className={cn(frame, 'items-center justify-center gap-2 text-[13px] text-muted-foreground')}>
        <DocumentTextIcon aria-hidden="true" className="h-5 w-5" />
        {tInk('no_document')}
      </div>
    )
  }
  if (state === 'error' || !meta) {
    return (
      <div className={cn(frame, 'flex-col items-center justify-center gap-3 px-6 text-center text-[13px] text-muted-foreground')}>
        <ExclamationTriangleIcon aria-hidden="true" className="h-5 w-5 text-attn" />
        <span>{t('document_load_failed')}</span>
        <Button variant="outline" size="sm" onClick={onRetry}>
          {t('retry')}
        </Button>
      </div>
    )
  }

  const kind = documentPreviewKind(meta.mime) ?? 'pdf'
  const fallback = (
    <a href={meta.url} target="_blank" rel="noopener noreferrer" className="block p-4 text-[13px] text-muted-foreground underline">
      {t('open_in_new_tab')}
    </a>
  )
  return kind === 'image' ? (
    <div className={cn(sheet, 'items-start justify-center')}>
      <DocumentPreview src={meta.url} kind={kind} label={tInk('document_label')} fallback={fallback} imageClassName="block h-auto max-h-full w-auto max-w-full object-contain" />
    </div>
  ) : (
    <div className={sheet}>
      {/* The page as a sheet: Chrome's viewer drops its toolbar and thumbnails
          and fits the page's width; "Öppna i full storlek" keeps the full viewer. */}
      <DocumentPreview src={kind === 'pdf' ? `${meta.url}#toolbar=0&navpanes=0&view=FitH` : meta.url} kind={kind} label={tInk('document_label')} fallback={fallback} className="h-full w-full border-0" />
    </div>
  )
}
