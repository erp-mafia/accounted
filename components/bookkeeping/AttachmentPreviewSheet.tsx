'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { ExternalLink, FileText, ImageIcon, Paperclip } from 'lucide-react'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'

interface DocumentRecord {
  id: string
  file_name: string
  file_size_bytes: number
  mime_type: string | null
  storage_path: string
  created_at: string
  download_url?: string
}

interface AttachmentPreviewSheetProps {
  entryId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

function isImageType(type: string | null): boolean {
  return type?.startsWith('image/') ?? false
}

function isPdfType(type: string | null): boolean {
  return type === 'application/pdf'
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export default function AttachmentPreviewSheet({
  entryId,
  open,
  onOpenChange,
}: AttachmentPreviewSheetProps) {
  const t = useTranslations('attachment_preview_sheet')
  const [documents, setDocuments] = useState<DocumentRecord[]>([])
  const [loading, setLoading] = useState(false)

  const fetchAttachments = useCallback(async (id: string) => {
    setLoading(true)
    try {
      const res = await fetch(
        `/api/documents?journal_entry_id=${id}&current_only=true`
      )
      const { data } = await res.json()
      const list: DocumentRecord[] = data || []

      // Pull a signed download_url for each — used by the
      // "open in new tab" link. The iframe/img sources use the
      // same-origin inline proxy and do not need download_url.
      const enriched = await Promise.all(
        list.map(async (doc) => {
          try {
            const r = await fetch(`/api/documents/${doc.id}`)
            const { data: detail } = await r.json()
            return detail?.download_url
              ? { ...doc, download_url: detail.download_url as string }
              : doc
          } catch {
            return doc
          }
        })
      )
      setDocuments(enriched)
    } catch {
      setDocuments([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open && entryId) {
      fetchAttachments(entryId)
    } else if (!open) {
      // Reset state when closed so the next open starts fresh
      setDocuments([])
    }
  }, [open, entryId, fetchAttachments])

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full overflow-y-auto sm:max-w-[560px]"
      >
        <SheetHeader>
          <SheetTitle>{t('title')}</SheetTitle>
        </SheetHeader>

        {loading ? (
          <div className="space-y-3">
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-[60vh] w-full rounded-lg" />
          </div>
        ) : documents.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <div className="mb-3 rounded-full bg-muted p-3">
              <Paperclip className="h-5 w-5 text-muted-foreground" />
            </div>
            <p className="text-sm text-muted-foreground">{t('empty')}</p>
          </div>
        ) : (
          <div className="space-y-6">
            {documents.map((doc) => {
              const inlineSrc = `/api/documents/${doc.id}/inline`
              const previewable = isImageType(doc.mime_type) || isPdfType(doc.mime_type)
              return (
                <div key={doc.id} className="space-y-2">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-start gap-2">
                      {isImageType(doc.mime_type) ? (
                        <ImageIcon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                      ) : (
                        <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                      )}
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">
                          {doc.file_name}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {formatFileSize(doc.file_size_bytes)}
                        </p>
                      </div>
                    </div>
                    {doc.download_url && (
                      <a
                        href={doc.download_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground transition-colors duration-150 hover:text-foreground"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                        {t('open_in_new_tab')}
                      </a>
                    )}
                  </div>

                  {isPdfType(doc.mime_type) && (
                    <iframe
                      src={inlineSrc}
                      title={doc.file_name}
                      className="h-[70vh] w-full rounded-lg border border-border"
                    />
                  )}

                  {isImageType(doc.mime_type) && (
                    <div className="overflow-hidden rounded-lg border border-border bg-muted/30">
                      <img
                        src={inlineSrc}
                        alt={doc.file_name}
                        className="mx-auto max-h-[70vh] w-full object-contain"
                      />
                    </div>
                  )}

                  {!previewable && (
                    <p className="rounded-lg border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
                      {t('not_previewable')}
                    </p>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
