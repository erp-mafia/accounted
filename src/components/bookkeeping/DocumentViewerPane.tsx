'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { ArrowTopRightOnSquareIcon, DocumentTextIcon } from '@/components/icons'
import { DocumentPreview } from '@/components/bookkeeping/DocumentPreview'
import { Skeleton, LateReveal } from '@/components/ui/skeleton'
import { documentPreviewKind } from '@/lib/documents/preview-kind'
import { cn } from '@/lib/utils'

/**
 * Side-by-side document viewer used while booking manually, so the user can
 * read the figures off a receipt/invoice while filling in the journal entry.
 *
 * Renders by document id through the same-origin inline proxy
 * (/api/documents/:id/inline), with the shared DocumentPreview body.
 *
 * Unlike AttachmentPreviewSheet this is keyed off a document id, not a
 * journal_entry_id: during manual booking the entry does not exist yet.
 */

interface DocumentViewerPaneProps {
  /** Document id. Bytes are served via the same-origin inline proxy. */
  documentId?: string | null
  /** Pre-known mime type. When omitted it's fetched from /api/documents/:id. */
  mime?: string | null
  /** Pre-known signed URL for the "open in new tab" link. Optional. */
  downloadUrl?: string | null
  /** Optional filename: used for mime sniffing on legacy/octet-stream files. */
  fileName?: string | null
  /** Open a PDF at this page (1-based): the browser plugin honours #page=N. */
  page?: number | null
  className?: string
}

export default function DocumentViewerPane({
  documentId,
  mime: mimeProp = null,
  downloadUrl: downloadUrlProp = null,
  fileName = null,
  page = null,
  className,
}: DocumentViewerPaneProps) {
  const t = useTranslations('document_viewer')
  // Fetched metadata is tagged with the document id it belongs to, so a stale
  // response for a previously-shown document is ignored rather than flashed.
  const [fetched, setFetched] = useState<
    { id: string; mime: string | null; url: string | null } | null
  >(null)

  // Resolve mime / download_url from the documents API only when the caller did
  // not supply a mime (e.g. a pre-linked transaction document). When a mime is
  // provided (fresh upload, inbox preview) we skip the round-trip entirely.
  // setState happens only inside the async callbacks: never synchronously in
  // the effect body: to avoid cascading renders (react-hooks/set-state-in-effect).
  useEffect(() => {
    if (!documentId || mimeProp) return
    let cancelled = false
    fetch(`/api/documents/${documentId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (cancelled) return
        setFetched({
          id: documentId,
          mime: body?.data?.mime_type ?? null,
          url: body?.data?.download_url ?? null,
        })
      })
      .catch(() => {
        // preview is best-effort: record an empty result so we stop "loading"
        if (!cancelled) setFetched({ id: documentId, mime: null, url: null })
      })
    return () => {
      cancelled = true
    }
  }, [documentId, mimeProp])

  const fetchedForThis = fetched?.id === documentId ? fetched : null
  const mime = mimeProp ?? fetchedForThis?.mime ?? null
  const downloadUrl = downloadUrlProp ?? fetchedForThis?.url ?? null
  const loadingMeta = !!documentId && !mimeProp && !fetchedForThis

  if (!documentId) {
    return (
      <div
        className={cn(
          'flex h-full w-full items-center justify-center rounded-lg text-sm text-muted-foreground bg-control shadow-raised',
          className,
        )}
      >
        <DocumentTextIcon className="mr-2 h-5 w-5" />
        {t('empty')}
      </div>
    )
  }

  const inlineSrc = `/api/documents/${documentId}/inline${page && page > 1 ? `#page=${page}` : ''}`
  // The pane shows a sized preview of a photo; a new tab opens the file itself, from the same origin.
  const newTabHref = downloadUrl ?? `/api/documents/${documentId}/inline?original=1`
  const kind = documentPreviewKind(mime, fileName)
  const label = fileName ?? t('header_label')

  return (
    <div
      className={cn(
        'flex h-full w-full flex-col overflow-hidden',
        className,
      )}
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-1.5">
        <span className="truncate text-xs text-muted-foreground">
          {fileName ?? t('header_label')}
        </span>
        <a
          href={newTabHref}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground transition-colors duration-150 hover:text-foreground"
        >
          <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" />
          {t('open_in_new_tab')}
        </a>
      </div>

      <div className="min-h-0 flex-1 overflow-auto bg-background">
        {loadingMeta ? (
          <LateReveal className="p-3">
            <Skeleton className="h-full min-h-[40vh] w-full" />
          </LateReveal>
        ) : kind === 'pdf' || kind === 'image' ? (
          <DocumentPreview
            src={inlineSrc}
            kind={kind}
            label={label}
            className="h-full w-full"
            imageClassName="mx-auto max-w-full object-contain"
            fallback={
              <div className="flex h-full w-full items-center justify-center p-4 text-center text-sm text-muted-foreground">
                {t('not_previewable')}
                {': '}
                <a
                  href={newTabHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ml-1 underline"
                >
                  {t('open_in_new_tab')}
                </a>
              </div>
            }
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-4 text-center text-sm text-muted-foreground">
            <DocumentTextIcon className="h-6 w-6" />
            <span>{t('not_previewable')}</span>
            <a
              href={newTabHref}
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              {t('open_in_new_tab')}
            </a>
          </div>
        )}
      </div>
    </div>
  )
}
