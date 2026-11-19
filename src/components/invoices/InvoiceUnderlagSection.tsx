'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { ArchiveBoxIcon, DocumentTextIcon, PaperClipIcon, SpinnerIcon, XMarkIcon } from '@/components/icons'
import { InvoiceArchivePicker, type ArchivedAttachmentPick } from '@/components/invoices/InvoiceArchivePicker'
import { Button } from '@/components/ui/button'
import { DetailSection } from '@/components/ui/detail-section'
import { HelpPopover } from '@/components/ui/help-popover'
import { Skeleton } from '@/components/ui/skeleton'
import { getResponseErrorMessage } from '@/lib/errors/get-error-message'
import { postDocumentForm } from '@/lib/documents/direct-upload'
import { prepareDocumentUpload } from '@/lib/documents/shrink-image'
import { DOCUMENT_MAX_UPLOAD_BYTES } from '@/lib/documents/upload-size'
import { DOCUMENT_UPLOAD_ACCEPT, isAllowedDocumentFile } from '@/lib/documents/upload-types'
import { formatAttachmentSize } from '@/lib/invoices/invoice-attachment-limits'
import type { InvoiceUnderlag } from '@/lib/invoices/invoice-underlag'
import { MAX_UNDERLAG_PER_CALL } from '@/lib/invoices/invoice-underlag-limits'

interface PendingUpload {
  key: string
  file_name: string
}

let pendingCounter = 0

/**
 * "Underlag" on the invoice page (accounted#42): the documents the invoice
 * rests on, such as the wholesaler invoices behind material a contractor
 * invoices onward. When the end customer asks what a line rests on, they are
 * here. Pick documents already in the archive (a supplier invoice's file is
 * found by supplier, file name or text) or upload a new one; open one in a
 * new tab; remove a link.
 *
 * A link is a reference only (lib/invoices/invoice-underlag.ts): the
 * document keeps its own verifikat, removing the link leaves it in the
 * archive, and nothing here is sent with the invoice. The files that go out
 * with the invoice are its Bilagor, chosen in the send step. Shown in every
 * state of the invoice, since the question usually comes after it went out.
 */
export function InvoiceUnderlagSection({ invoiceId, canWrite }: { invoiceId: string; canWrite: boolean }) {
  const t = useTranslations('invoice_underlag')
  const locale = useLocale() as 'sv' | 'en'
  const inputRef = useRef<HTMLInputElement>(null)
  const [rows, setRows] = useState<InvoiceUnderlag[]>([])
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState<PendingUpload[]>([])
  const [removing, setRemoving] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void (async () => {
      try {
        const res = await fetch(`/api/invoices/${invoiceId}/underlag`)
        if (!res.ok) throw new Error(await getResponseErrorMessage(res, 'invoice', locale))
        const json = (await res.json()) as { data?: { underlag?: InvoiceUnderlag[] } }
        if (!cancelled) setRows(json.data?.underlag ?? [])
      } catch {
        if (!cancelled) setError(t('load_failed'))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [invoiceId, locale, t])

  /** Link archived documents; answers an error sentence, or null when linked. */
  const link = useCallback(
    async (documentIds: string[]): Promise<string | null> => {
      const res = await fetch(`/api/invoices/${invoiceId}/underlag`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ document_ids: documentIds }),
      })
      if (!res.ok) return getResponseErrorMessage(res, 'invoice', locale)
      const json = (await res.json()) as { data?: { underlag?: InvoiceUnderlag[] } }
      setRows(json.data?.underlag ?? [])
      return null
    },
    [invoiceId, locale],
  )

  const uploadAndLink = useCallback(
    async (file: File): Promise<string | null> => {
      const prepared = await prepareDocumentUpload(file)
      if (!prepared.ok) {
        return t('file_too_large', { name: file.name, limit: formatAttachmentSize(DOCUMENT_MAX_UPLOAD_BYTES, locale) })
      }
      const form = new FormData()
      form.append('upload_source', 'file_upload')
      // The same bytes already in the books (a supplier invoice's file):
      // link that document instead of storing a second copy.
      form.append('dedupe_by_content', 'true')
      const upload = await postDocumentForm('/api/documents', form, prepared.file)
      if (!upload.ok) return getResponseErrorMessage(upload, undefined, locale)
      const uploaded = (await upload.json()) as { data?: { id?: string } }
      const documentId = uploaded.data?.id
      if (!documentId) return t('upload_failed', { name: file.name })
      return link([documentId])
    },
    [link, locale, t],
  )

  const handleFiles = useCallback(
    async (files: File[]) => {
      setError(null)
      const accepted: Array<{ file: File; key: string }> = []
      for (const file of files) {
        if (!isAllowedDocumentFile(file)) {
          setError(t('unsupported_type', { name: file.name }))
          continue
        }
        accepted.push({ file, key: `invoice-underlag-${++pendingCounter}` })
      }
      if (accepted.length === 0) return
      setPending((current) => [...current, ...accepted.map(({ file, key }) => ({ key, file_name: file.name }))])
      // One at a time: the order they were picked is the order they are listed in.
      for (const { file, key } of accepted) {
        let failure: string | null
        try {
          failure = await uploadAndLink(file)
        } catch {
          failure = t('upload_failed', { name: file.name })
        }
        if (failure) setError(failure)
        setPending((current) => current.filter((p) => p.key !== key))
      }
    },
    [t, uploadAndLink],
  )

  const linkArchived = useCallback(
    async (docs: ArchivedAttachmentPick[]) => {
      setError(null)
      const fresh = docs.filter((d) => !rows.some((r) => r.document_id === d.document_id))
      if (fresh.length === 0) return
      const waiting = fresh.map((d) => ({ key: `invoice-underlag-${++pendingCounter}`, file_name: d.file_name }))
      setPending((current) => [...current, ...waiting])
      try {
        // A call takes at most MAX_UNDERLAG_PER_CALL documents: a larger pick goes in turns.
        for (let i = 0; i < fresh.length; i += MAX_UNDERLAG_PER_CALL) {
          const failure = await link(fresh.slice(i, i + MAX_UNDERLAG_PER_CALL).map((d) => d.document_id))
          if (failure) {
            setError(failure)
            break
          }
        }
      } catch {
        setError(t('link_failed'))
      } finally {
        setPending((current) => current.filter((p) => !waiting.some((w) => w.key === p.key)))
      }
    },
    [link, rows, t],
  )

  const remove = useCallback(
    async (documentId: string) => {
      setError(null)
      setRemoving(documentId)
      try {
        const res = await fetch(`/api/invoices/${invoiceId}/underlag/${documentId}`, { method: 'DELETE' })
        if (!res.ok) {
          setError(await getResponseErrorMessage(res, 'invoice', locale))
          return
        }
        setRows((current) => current.filter((r) => r.document_id !== documentId))
      } catch {
        setError(t('remove_failed'))
      } finally {
        setRemoving(null)
      }
    },
    [invoiceId, locale, t],
  )

  // The same-origin inline proxy shows a PDF in the browser's viewer and
  // renders an image, instead of downloading the file (DocumentViewButton).
  const open = (documentId: string) => {
    const tab = window.open(`/api/documents/${documentId}/inline`, '_blank')
    if (tab) tab.opener = null
    else setError(t('open_blocked'))
  }

  // One write at a time: each answer replaces the list, so a late answer
  // must never land on top of a newer one.
  const busy = pending.length > 0 || removing !== null

  return (
    <DetailSection
      kicker={t('title')}
      help={
        <HelpPopover>
          <p>{t('help_what')}</p>
          <p className="mt-2">{t('help_not_sent')}</p>
        </HelpPopover>
      }
      aside={
        rows.length > 0 ? (
          <span className="text-[11px] tabular-nums text-muted-foreground">{t('count', { count: rows.length })}</span>
        ) : undefined
      }
    >
      {loading ? (
        <Skeleton className="h-4 w-1/2" />
      ) : rows.length + pending.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <ul className="stagger-enter divide-y divide-border text-sm">
          {rows.map((row) => (
            <li key={row.document_id} className="flex min-w-0 items-center gap-3 py-2">
              <DocumentTextIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
              {/* data-ph-mask: the file name is user data */}
              <button
                type="button"
                onClick={() => open(row.document_id)}
                title={t('open', { name: row.file_name })}
                className="min-w-0 flex-1 truncate text-left underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-none"
                data-ph-mask=""
              >
                {row.file_name}
              </button>
              {row.voucher && (
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {t('on_voucher', { voucher: row.voucher })}
                </span>
              )}
              <span className="hidden shrink-0 text-xs tabular-nums text-muted-foreground sm:inline">
                {formatAttachmentSize(row.file_size_bytes, locale)}
              </span>
              {canWrite && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t('remove', { name: row.file_name })}
                  title={t('remove', { name: row.file_name })}
                  className="shrink-0"
                  loading={removing === row.document_id}
                  disabled={busy}
                  onClick={() => void remove(row.document_id)}
                >
                  <XMarkIcon className="h-4 w-4" />
                </Button>
              )}
            </li>
          ))}
          {pending.map((p) => (
            <li key={p.key} className="flex min-w-0 items-center gap-3 py-2 text-muted-foreground">
              <SpinnerIcon className="h-4 w-4 shrink-0 animate-spin" aria-label={t('linking')} />
              <span className="min-w-0 flex-1 truncate" data-ph-mask="">
                {p.file_name}
              </span>
            </li>
          ))}
        </ul>
      )}

      {canWrite && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={() => setPickerOpen(true)} disabled={loading || busy}>
            <ArchiveBoxIcon className="h-4 w-4" />
            {t('choose_from_archive')}
          </Button>
          <Button type="button" variant="outline" onClick={() => inputRef.current?.click()} disabled={loading || busy}>
            <PaperClipIcon className="h-4 w-4" />
            {t('upload')}
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
      )}

      {error && (
        <p className="mt-2 text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      {canWrite && (
        <InvoiceArchivePicker
          open={pickerOpen}
          onClose={() => setPickerOpen(false)}
          channel="underlag"
          attachedIds={rows.map((r) => r.document_id)}
          usedCount={0}
          usedBytes={0}
          onPick={(docs) => void linkArchived(docs)}
        />
      )}
    </DetailSection>
  )
}
