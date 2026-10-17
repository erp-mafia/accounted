'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { FileText, Loader2, Paperclip, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { HelpPopover } from '@/components/ui/help-popover'
import { Skeleton } from '@/components/ui/skeleton'
import { getErrorMessage, getResponseErrorMessage } from '@/lib/errors/get-error-message'
import { prepareForMultipartUpload } from '@/lib/documents/shrink-image'
import { DOCUMENT_UPLOAD_ACCEPT, isAllowedDocumentFile } from '@/lib/documents/upload-types'
import {
  MAX_INVOICE_ATTACHMENTS,
  MAX_INVOICE_ATTACHMENTS_TOTAL_BYTES,
} from '@/lib/invoices/invoice-attachment-limits'

/** The archive's own per-file ceiling (MAX_DOCUMENT_SIZE in the document service). */
const MAX_FILE_BYTES = 10 * 1024 * 1024

interface AttachedFile {
  document_id: string
  file_name: string
  file_size_bytes: number | null
}

interface PendingFile {
  key: string
  file_name: string
  file_size_bytes: number
}

function formatSize(bytes: number | null, locale: string): string {
  if (bytes === null) return ''
  const number = new Intl.NumberFormat(locale === 'en' ? 'en-GB' : 'sv-SE', { maximumFractionDigits: 1 })
  if (bytes < 1024 * 1024) return `${number.format(Math.max(bytes / 1024, 0.1))} KB`
  return `${number.format(bytes / (1024 * 1024))} MB`
}

let pendingCounter = 0

/**
 * "Bilagor" in the send dialog (crm#1269): files emailed after the invoice
 * PDF. Each file is uploaded to the archive (POST /api/documents, the same
 * pipeline and checks as every other upload) and attached to the draft at
 * once, so the list is the invoice's own and survives closing the dialog.
 * Removing a file before the send takes it off the invoice; the upload stays
 * in the archive. After the send the attachments are fixed.
 */
export function InvoiceAttachmentsSection({
  invoiceId,
  disabled = false,
  onBusyChange,
}: {
  invoiceId: string
  disabled?: boolean
  /** True while a file is uploading or being removed: the send waits for it. */
  onBusyChange?: (busy: boolean) => void
}) {
  const t = useTranslations('invoice_attachments')
  const locale = useLocale() as 'sv' | 'en'
  const inputRef = useRef<HTMLInputElement>(null)
  const [loading, setLoading] = useState(true)
  const [attached, setAttached] = useState<AttachedFile[]>([])
  const [pending, setPending] = useState<PendingFile[]>([])
  const [removing, setRemoving] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const busy = pending.length > 0 || removing !== null
  useEffect(() => {
    onBusyChange?.(busy)
  }, [busy, onBusyChange])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    ;(async () => {
      try {
        const res = await fetch(`/api/invoices/${invoiceId}/attachments`)
        if (!res.ok) throw new Error(await getResponseErrorMessage(res, 'invoice', locale))
        const json = (await res.json()) as { data?: AttachedFile[] }
        if (!cancelled) setAttached(json.data ?? [])
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? getErrorMessage(err, { locale, context: 'invoice' }) : t('load_failed'))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [invoiceId, locale, t])

  const usedBytes = attached.reduce((sum, a) => sum + (a.file_size_bytes ?? 0), 0)
  const full = attached.length + pending.length >= MAX_INVOICE_ATTACHMENTS

  const uploadAndAttach = useCallback(
    async (file: File, key: string): Promise<string | null> => {
      const prepared = await prepareForMultipartUpload(file)
      if (!prepared.ok) return prepared.message
      const form = new FormData()
      form.append('file', prepared.file)
      form.append('upload_source', 'file_upload')
      const upload = await fetch('/api/documents', { method: 'POST', body: form })
      if (!upload.ok) return getResponseErrorMessage(upload, undefined, locale)
      const uploaded = (await upload.json()) as { data?: { id?: string } }
      const documentId = uploaded.data?.id
      if (!documentId) return t('upload_failed', { name: file.name })

      const link = await fetch(`/api/invoices/${invoiceId}/attachments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ document_ids: [documentId] }),
      })
      if (!link.ok) return getResponseErrorMessage(link, 'invoice', locale)
      const linked = (await link.json()) as { data?: AttachedFile[] }
      setAttached(linked.data ?? [])
      setPending((current) => current.filter((p) => p.key !== key))
      return null
    },
    [invoiceId, locale, t],
  )

  const handleFiles = useCallback(
    async (files: File[]) => {
      setError(null)
      let count = attached.length + pending.length
      let bytes = usedBytes + pending.reduce((sum, p) => sum + p.file_size_bytes, 0)
      const accepted: Array<{ file: File; key: string }> = []
      for (const file of files) {
        if (!isAllowedDocumentFile(file)) {
          setError(t('unsupported_type', { name: file.name }))
          continue
        }
        if (file.size > MAX_FILE_BYTES) {
          setError(t('file_too_large', { name: file.name }))
          continue
        }
        if (count + 1 > MAX_INVOICE_ATTACHMENTS) {
          setError(t('too_many', { count: MAX_INVOICE_ATTACHMENTS }))
          break
        }
        if (bytes + file.size > MAX_INVOICE_ATTACHMENTS_TOTAL_BYTES) {
          setError(t('total_too_large'))
          continue
        }
        count += 1
        bytes += file.size
        accepted.push({ file, key: `invoice-attachment-${++pendingCounter}` })
      }
      if (accepted.length === 0) return

      setPending((current) => [
        ...current,
        ...accepted.map(({ file, key }) => ({ key, file_name: file.name, file_size_bytes: file.size })),
      ])
      // One at a time: the order they were picked is the order they are emailed.
      for (const { file, key } of accepted) {
        let failure: string | null
        try {
          failure = await uploadAndAttach(file, key)
        } catch {
          failure = t('upload_failed', { name: file.name })
        }
        if (failure) {
          setError(failure)
          setPending((current) => current.filter((p) => p.key !== key))
        }
      }
    },
    [attached.length, pending, t, uploadAndAttach, usedBytes],
  )

  const remove = useCallback(
    async (documentId: string) => {
      setError(null)
      setRemoving(documentId)
      try {
        const res = await fetch(`/api/invoices/${invoiceId}/attachments/${documentId}`, { method: 'DELETE' })
        if (!res.ok) {
          setError(await getResponseErrorMessage(res, 'invoice', locale))
          return
        }
        setAttached((current) => current.filter((a) => a.document_id !== documentId))
      } catch {
        setError(t('remove_failed'))
      } finally {
        setRemoving(null)
      }
    },
    [invoiceId, locale, t],
  )

  return (
    <div className="space-y-2 rounded-lg border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <p className="text-sm font-medium">{t('title')}</p>
          <HelpPopover>
            <p>{t('help_what', { count: MAX_INVOICE_ATTACHMENTS, size: formatSize(MAX_INVOICE_ATTACHMENTS_TOTAL_BYTES, locale) })}</p>
            <p className="mt-2">{t('help_retention')}</p>
          </HelpPopover>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => inputRef.current?.click()}
          disabled={disabled || loading || full}
        >
          <Paperclip className="mr-2 h-4 w-4" />
          {t('add')}
        </Button>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={DOCUMENT_UPLOAD_ACCEPT}
          className="hidden"
          onChange={(event) => {
            const files = Array.from(event.target.files ?? [])
            event.target.value = ''
            if (files.length > 0) void handleFiles(files)
          }}
        />
      </div>

      {loading ? (
        <Skeleton className="h-4 w-1/2" />
      ) : attached.length + pending.length > 0 ? (
        <ul className="space-y-1">
          {attached.map((a) => (
            <li
              key={a.document_id}
              className="flex min-w-0 items-center gap-2 rounded-sm bg-muted/50 px-2 py-1 text-sm"
            >
              <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
              {/* data-ph-mask: the file name is user data */}
              <span className="min-w-0 flex-1 truncate" title={a.file_name} data-ph-mask="">
                {a.file_name}
              </span>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {formatSize(a.file_size_bytes, locale)}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t('remove', { name: a.file_name })}
                className="shrink-0"
                loading={removing === a.document_id}
                disabled={disabled || removing !== null}
                onClick={() => void remove(a.document_id)}
              >
                <X className="h-3 w-3" />
              </Button>
            </li>
          ))}
          {pending.map((p) => (
            <li
              key={p.key}
              className="flex min-w-0 items-center gap-2 rounded-sm bg-muted/50 px-2 py-1 text-sm text-muted-foreground"
            >
              <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-label={t('uploading')} />
              <span className="min-w-0 flex-1 truncate" title={p.file_name} data-ph-mask="">
                {p.file_name}
              </span>
              <span className="shrink-0 text-xs tabular-nums">{formatSize(p.file_size_bytes, locale)}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
