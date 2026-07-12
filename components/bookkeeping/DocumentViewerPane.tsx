'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { ExternalLink, FileText } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

/**
 * Side-by-side document viewer used while booking manually, so the user can
 * read the figures off a receipt/invoice while filling in the journal entry.
 *
 * Renders by document id through the same-origin inline proxy
 * (/api/documents/:id/inline). PDFs use <object type="application/pdf"> rather
 * than <iframe>: Chrome intermittently blocks PDFs in a frame even with a
 * permissive CSP (see the note in AttachmentPreviewSheet), and <object>
 * invokes the PDF plugin directly. Images use <img>.
 *
 * Unlike AttachmentPreviewSheet this is keyed off a document id, not a
 * journal_entry_id: during manual booking the entry does not exist yet.
 */

function isImageType(type: string | null, fileName?: string | null): boolean {
  if (type?.startsWith('image/')) return true
  // Legacy uploads sometimes leave mime_type null or application/octet-stream:
  // fall back to the filename extension.
  if (type === null || type === 'application/octet-stream') {
    return /\.(jpe?g|png|gif|webp|svg)$/i.test(fileName ?? '')
  }
  return false
}

function isPdfType(type: string | null, fileName?: string | null): boolean {
  if (type === 'application/pdf') return true
  if (type === null || type === 'application/octet-stream') {
    return fileName?.toLowerCase().endsWith('.pdf') ?? false
  }
  return false
}

interface DocumentViewerPaneProps {
  /** Document id. Bytes are served via the same-origin inline proxy. */
  documentId?: string | null
  /** Pre-known mime type. When omitted it's fetched from /api/documents/:id. */
  mime?: string | null
  /** Pre-known signed URL for the "open in new tab" link. Optional. */
  downloadUrl?: string | null
  /** Optional filename: used for mime sniffing on legacy/octet-stream files. */
  fileName?: string | null
  className?: string
}

export default function DocumentViewerPane({
  documentId,
  mime: mimeProp = null,
  downloadUrl: downloadUrlProp = null,
  fileName = null,
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
          'flex h-full w-full items-center justify-center rounded-lg border bg-muted/20 text-sm text-muted-foreground',
          className,
        )}
      >
        <FileText className="mr-2 h-5 w-5" />
        {t('empty')}
      </div>
    )
  }

  const inlineSrc = `/api/documents/${documentId}/inline`
  const newTabHref = downloadUrl ?? inlineSrc
  const showAsImage = isImageType(mime, fileName)
  const showAsPdf = isPdfType(mime, fileName)

  return (
    <div
      className={cn(
        'flex h-full w-full flex-col overflow-hidden rounded-lg border bg-muted/20',
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
          <ExternalLink className="h-3.5 w-3.5" />
          {t('open_in_new_tab')}
        </a>
      </div>

      <div className="min-h-0 flex-1 overflow-auto bg-background">
        {loadingMeta ? (
          <div className="p-3">
            <Skeleton className="h-full min-h-[40vh] w-full rounded-md" />
          </div>
        ) : showAsPdf ? (
          <object
            data={inlineSrc}
            type="application/pdf"
            aria-label={fileName ?? t('header_label')}
            className="h-full w-full"
          >
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
          </object>
        ) : showAsImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={inlineSrc}
            alt={fileName ?? t('header_label')}
            className="mx-auto max-w-full object-contain"
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-4 text-center text-sm text-muted-foreground">
            <FileText className="h-6 w-6" />
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
