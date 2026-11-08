'use client'

import { useEffect, useMemo, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import DocumentViewerPane from '@/components/bookkeeping/DocumentViewerPane'
import { DocumentTextIcon, MagnifyingGlassIcon, PhotoIcon } from '@/components/icons'
import type { ArkivDocumentRow } from '@/app/api/arkiv/documents/route'
import { documentPreviewKind } from '@/lib/documents/preview-kind'
import {
  MAX_INVOICE_ATTACHMENTS,
  MAX_INVOICE_ATTACHMENT_FILE_BYTES,
  MAX_PEPPOL_ATTACHMENTS_TOTAL_BYTES,
  archivedAttachmentRefusal,
  formatAttachmentSize,
  type InvoiceAttachmentRefusal,
} from '@/lib/invoices/invoice-attachment-limits'
import { cn, formatCurrency, formatDate } from '@/lib/utils'

/** A document picked from the archive, in the shape the attachment list holds. */
export interface ArchivedAttachmentPick {
  document_id: string
  file_name: string
  file_size_bytes: number | null
}

/**
 * "Välj från arkivet" in Bilagor (accounted#42): attach a document that is
 * already in the archive, such as the wholesaler's invoice behind material a
 * contractor invoices onward, instead of downloading and uploading it again.
 *
 * The list is the Arkiv list (GET /api/arkiv/documents, the same rows and the
 * same page-text search the "Andra verifikationer" picker reads), so a
 * supplier invoice's underlag is found by supplier, file name or text. A pick
 * only references the document: it stays on its own verifikat, untouched.
 * Each row is checked like a picked file (archivedAttachmentRefusal: type,
 * PDF only over Peppol, per-file and total size, count), so the picker never
 * offers what the upload path would refuse. The caller links the picks.
 * With channel 'underlag' (the invoice page's Underlag section) nothing is
 * sent, so no send limit applies: every document can be picked.
 */
export function InvoiceArchivePicker({
  open,
  onClose,
  channel,
  attachedIds,
  usedCount,
  usedBytes,
  onPick,
}: {
  open: boolean
  onClose: () => void
  /** The send that carries the picks, or 'underlag': linked as the invoice's underlag, never sent. */
  channel: 'email' | 'peppol' | 'underlag'
  /** Documents the invoice already carries: listed as attached, not offered again. */
  attachedIds: string[]
  /** Files the invoice carries or is uploading now, and their bytes: they count toward the limits. */
  usedCount: number
  usedBytes: number
  /** The picks, in the order they were ticked (the order they are sent in). */
  onPick: (docs: ArchivedAttachmentPick[]) => void
}) {
  const t = useTranslations('invoice_attachments')
  const locale = useLocale()
  const [rows, setRows] = useState<ArkivDocumentRow[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<ArkivDocumentRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<ArkivDocumentRow | null>(null)

  // A fresh start each time it opens.
  useEffect(() => {
    if (!open) return
    setSearch('')
    setSelected([])
    setError(null)
    setPreview(null)
  }, [open])

  // Searched on the server (page text and file names) from two characters,
  // newest first; a shorter query narrows the loaded rows below.
  const serverQuery = search.trim().length >= 2 ? search.trim() : ''
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    const timer = setTimeout(
      () => {
        void (async () => {
          try {
            const params = new URLSearchParams({ limit: '100' })
            if (serverQuery) params.set('q', serverQuery)
            const res = await fetch(`/api/arkiv/documents?${params.toString()}`)
            if (!res.ok) throw new Error(String(res.status))
            const json = (await res.json()) as { data?: ArkivDocumentRow[] }
            if (!cancelled) setRows(json.data ?? [])
          } catch {
            if (!cancelled) {
              setRows([])
              setError(t('picker_load_failed'))
            }
          } finally {
            if (!cancelled) setLoading(false)
          }
        })()
      },
      serverQuery ? 300 : 0,
    )
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [open, serverQuery, t])

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q || serverQuery) return rows
    return rows.filter((r) => `${r.title} ${r.counterparty ?? ''} ${r.file_name}`.toLowerCase().includes(q))
  }, [rows, search, serverQuery])

  const attachedSet = useMemo(() => new Set(attachedIds), [attachedIds])
  const selectedBytes = selected.reduce((sum, r) => sum + (r.file_size_bytes ?? 0), 0)

  const size = (bytes: number | null) => formatAttachmentSize(bytes, locale)
  const refusalMessage = (refusal: InvoiceAttachmentRefusal, row: ArkivDocumentRow): string => {
    switch (refusal) {
      case 'unsupported_type':
        return t('unsupported_type', { name: row.file_name })
      case 'peppol_pdf_only':
        return t('peppol_pdf_only', { name: row.file_name })
      case 'too_large':
        return t('file_too_large', {
          name: row.file_name,
          size: size(row.file_size_bytes),
          limit: size(MAX_INVOICE_ATTACHMENT_FILE_BYTES),
        })
      case 'too_many':
        return t('too_many', { count: MAX_INVOICE_ATTACHMENTS })
      case 'total_too_large':
        return channel === 'peppol'
          ? t('peppol_total_too_large', { size: size(MAX_PEPPOL_ATTACHMENTS_TOTAL_BYTES) })
          : t('total_too_large')
    }
  }
  const refusalNote = (refusal: InvoiceAttachmentRefusal): string =>
    refusal === 'peppol_pdf_only'
      ? t('picker_not_pdf')
      : refusal === 'unsupported_type'
        ? t('picker_unsupported')
        : t('picker_too_large')

  function toggle(row: ArkivDocumentRow, checked: boolean) {
    setError(null)
    if (!checked) {
      setSelected((current) => current.filter((r) => r.document_id !== row.document_id))
      return
    }
    const refusal =
      channel === 'underlag'
        ? null
        : archivedAttachmentRefusal(row, { count: usedCount + selected.length, bytes: usedBytes + selectedBytes }, channel)
    if (refusal) {
      setError(refusalMessage(refusal, row))
      return
    }
    setSelected((current) => (current.some((r) => r.document_id === row.document_id) ? current : [...current, row]))
  }

  function close() {
    setPreview(null)
    onClose()
  }

  function confirm() {
    onPick(
      selected.map((r) => ({ document_id: r.document_id, file_name: r.file_name, file_size_bytes: r.file_size_bytes })),
    )
    close()
  }

  const hasSearch = search.trim().length > 0

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => !o && close()}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('picker_title')}</DialogTitle>
            <DialogDescription>
              {channel === 'peppol'
                ? t('picker_description_peppol')
                : channel === 'underlag'
                  ? t('picker_description_underlag')
                  : t('picker_description')}
            </DialogDescription>
          </DialogHeader>

          <div className="relative">
            <MagnifyingGlassIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('picker_search_placeholder')}
              aria-label={t('picker_search_placeholder')}
              className="pl-9"
            />
          </div>

          <div className="-mx-6 max-h-[55vh] divide-y overflow-y-auto px-6">
            {loading ? (
              <div className="space-y-3 py-3">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : visible.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-10 text-center">
                <DocumentTextIcon className="h-6 w-6 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  {hasSearch ? t('picker_empty_search', { query: search.trim() }) : t('picker_empty')}
                </p>
              </div>
            ) : (
              visible.map((row) => {
                const isAttached = attachedSet.has(row.document_id)
                const refusal =
                  isAttached || channel === 'underlag' ? null : archivedAttachmentRefusal(row, { count: 0, bytes: 0 }, channel)
                const isSelected = selected.some((r) => r.document_id === row.document_id)
                const unavailable = isAttached || refusal !== null
                const id = `invoice-archive-pick-${row.document_id}`
                return (
                  <div
                    key={row.document_id}
                    className="flex items-center gap-3 rounded-sm px-2 transition-colors hover:bg-secondary/35"
                  >
                    <Checkbox
                      id={id}
                      checked={isAttached || isSelected}
                      disabled={unavailable}
                      onCheckedChange={(checked) => toggle(row, checked === true)}
                    />
                    <label
                      htmlFor={id}
                      title={refusal ? refusalMessage(refusal, row) : undefined}
                      className={cn(
                        'flex min-w-0 flex-1 items-center gap-3 py-3',
                        unavailable ? 'cursor-not-allowed text-muted-foreground' : 'cursor-pointer',
                      )}
                    >
                      {documentPreviewKind(row.mime_type, row.file_name) === 'image' ? (
                        <PhotoIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                      ) : (
                        <DocumentTextIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                      )}
                      <div className="min-w-0 flex-1">
                        {/* data-ph-mask: titles, counterparties and file names are user data */}
                        <span data-ph-mask="" className="block truncate text-sm font-medium">
                          {row.title}
                        </span>
                        <div className="flex min-w-0 items-center gap-2 text-xs tabular-nums text-muted-foreground">
                          {row.document_date && <span className="shrink-0">{formatDate(row.document_date)}</span>}
                          {row.counterparty && (
                            <span data-ph-mask="" className="truncate">
                              {row.counterparty}
                            </span>
                          )}
                          {row.linked.voucher && (
                            <span className="shrink-0">{t('picker_on_voucher', { voucher: row.linked.voucher })}</span>
                          )}
                        </div>
                      </div>
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                        {isAttached
                          ? t('picker_attached')
                          : refusal
                            ? refusalNote(refusal)
                            : row.amount != null
                              ? formatCurrency(row.amount, row.currency ?? 'SEK')
                              : size(row.file_size_bytes)}
                      </span>
                    </label>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="shrink-0 text-muted-foreground"
                      onClick={() => setPreview(row)}
                    >
                      {t('picker_preview')}
                    </Button>
                  </div>
                )
              })
            )}
          </div>

          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              {t('picker_cancel')}
            </Button>
            <Button type="button" onClick={confirm} disabled={selected.length === 0}>
              {channel === 'underlag'
                ? t('picker_add_underlag', { count: selected.length })
                : t('picker_attach', { count: selected.length })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={preview !== null} onOpenChange={(o) => !o && setPreview(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle data-ph-mask="" className="truncate pr-6">
              {preview?.title}
            </DialogTitle>
            <DialogDescription data-ph-mask="" className="truncate">
              {preview?.file_name}
            </DialogDescription>
          </DialogHeader>
          {preview && (
            <DocumentViewerPane
              documentId={preview.document_id}
              mime={preview.mime_type}
              fileName={preview.file_name}
              className="h-[70vh]"
            />
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setPreview(null)}>
              {t('picker_close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
