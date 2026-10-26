'use client'

import { useState, useEffect, useMemo } from 'react'
import { useTranslations, useLocale } from 'next-intl'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Input } from '@/components/ui/input'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { useToast } from '@/components/ui/use-toast'
import type { ArkivDocumentRow } from '@/app/api/arkiv/documents/route'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { DocumentPreview } from '@/components/bookkeeping/DocumentPreview'
import { documentPreviewKind } from '@/lib/documents/preview-kind'
import {
  DocumentTextIcon,
  InboxIcon,
  MagnifyingGlassIcon,
  PhotoIcon,
  SpinnerIcon,
} from '@/components/icons'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'

// InboxDocumentPicker
//
// Lists invoice-inbox documents that have not yet been consumed (no supplier
// invoice, no journal entry, not matched to a transaction, document not
// already linked) so the user can attach one as underlag to a verifikat.
//
// Two modes:
// - Link mode (JournalEntryAttachments, "Välj från inkorgen"): `journalEntryId`
//   is set and picking a document immediately links it to the journal entry AND
//   stamps the inbox item so it drops out of the active inbox: see
//   app/api/documents/[id]/link/route.ts.
// - Select mode (TransactionBookingDialog, "Välj befintligt underlag"): the
//   journal entry does not exist yet, so `onSelect` is provided instead and the
//   pick is reported to the parent, which links after the entry is created.
//
// Each row carries a "Förhandsgranska" button that opens a quick dialog
// rendering the document inline, so the user can confirm the right file before
// attaching. It is a word, not the eye icon it used to be: an eye reads as a
// show/hide toggle (crm#1003). Attaching is the row's primary click (fast
// path) and is also offered from inside the preview dialog (preview → confirm).
//
// Link mode also offers "Andra verifikationer": underlag another verifikat
// already holds, read from the Arkiv list (crm#1171 item 9: one bank
// statement backing two fees). A document row holds one verifikat for good,
// so picking one opens a confirm and links a byte-identical copy (POST link
// with copy: true); the original stays where it is.

export interface AvailableInboxDoc {
  inbox_item_id: string
  document_id: string
  file_name: string
  mime_type: string | null
  file_size_bytes: number
  source: string | null
  created_at: string
  supplier_name: string | null
  amount: number | null
  currency: string | null
  invoice_date: string | null
}

interface Props {
  open: boolean
  onClose: () => void
  /** Link mode: the journal entry to link the picked document to. */
  journalEntryId?: string
  /** Link mode: called after a successful link so the parent can refresh its document list. */
  onLinked?: () => void
  /** Select mode: report the picked document to the parent instead of linking. */
  onSelect?: (doc: AvailableInboxDoc) => void
}

/** The picker previews files only; a mail body opens from the inbox itself. */
function pickerPreviewKind(mime: string | null, fileName: string) {
  const kind = documentPreviewKind(mime, fileName)
  return kind === 'html' ? null : kind
}

type PickerSource = 'inbox' | 'linked'

/** A document another verifikat already holds, as the Arkiv list gives it. */
interface LinkedElsewhereDoc {
  document_id: string
  file_name: string
  title: string
  document_date: string | null
  voucher: string | null
}

function DocIcon({ mime, fileName }: { mime: string | null; fileName: string }) {
  if (documentPreviewKind(mime, fileName) === 'image') {
    return <PhotoIcon className="h-4 w-4 text-muted-foreground shrink-0" />
  }
  return <DocumentTextIcon className="h-4 w-4 text-muted-foreground shrink-0" />
}

export default function InboxDocumentPicker({ open, onClose, journalEntryId, onLinked, onSelect }: Props) {
  const t = useTranslations('journal_attachments')
  const errorLocale = useLocale() as ErrorLocale
  const { toast } = useToast()

  const [loading, setLoading] = useState(true)
  const [items, setItems] = useState<AvailableInboxDoc[]>([])
  const [search, setSearch] = useState('')
  const [linkingId, setLinkingId] = useState<string | null>(null)
  const [previewItem, setPreviewItem] = useState<AvailableInboxDoc | null>(null)
  // Link mode only: underlag already on another verifikat, linked as a copy.
  const [source, setSource] = useState<PickerSource>('inbox')
  const [linkedItems, setLinkedItems] = useState<LinkedElsewhereDoc[]>([])
  const [linkedLoading, setLinkedLoading] = useState(false)
  const [copyItem, setCopyItem] = useState<LinkedElsewhereDoc | null>(null)
  const linkMode = Boolean(journalEntryId) && !onSelect

  // Reset + fetch each time the dialog opens.
  useEffect(() => {
    if (!open) return
    setSearch('')
    setItems([])
    setPreviewItem(null)
    setSource('inbox')
    setCopyItem(null)
    setLoading(true)
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/documents/inbox-available')
        const json = (await res.json().catch(() => ({}))) as { data?: AvailableInboxDoc[] }
        if (cancelled) return
        setItems(json.data ?? [])
      } catch {
        if (!cancelled) setItems([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open])

  // Underlag on other verifikat: the Arkiv list, searched on the server (page
  // text and file names) once two characters are typed, newest first.
  const serverQuery = search.trim().length >= 2 ? search.trim() : ''
  useEffect(() => {
    if (!open || source !== 'linked' || !journalEntryId) return
    let cancelled = false
    setLinkedLoading(true)
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const params = new URLSearchParams({ limit: '100' })
          if (serverQuery) params.set('q', serverQuery)
          const res = await fetch(`/api/arkiv/documents?${params.toString()}`)
          const json = (await res.json().catch(() => ({}))) as { data?: ArkivDocumentRow[] }
          if (cancelled) return
          setLinkedItems(
            (json.data ?? [])
              .filter((row) => row.linked.journal_entry_id && row.linked.journal_entry_id !== journalEntryId)
              .map((row) => ({
                document_id: row.document_id,
                file_name: row.file_name,
                title: row.title,
                document_date: row.document_date,
                voucher: row.linked.voucher,
              })),
          )
        } catch {
          if (!cancelled) setLinkedItems([])
        } finally {
          if (!cancelled) setLinkedLoading(false)
        }
      })()
    }, serverQuery ? 300 : 0)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [open, source, journalEntryId, serverQuery])

  async function handleCopy(doc: LinkedElsewhereDoc) {
    if (!journalEntryId) return
    setLinkingId(doc.document_id)
    try {
      const res = await fetch(`/api/documents/${doc.document_id}/link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ journal_entry_id: journalEntryId, copy: true }),
      })
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string | { message?: string } }
        const description = json.error ? getErrorMessage(json, { locale: errorLocale }) : undefined
        toast({ title: t('picker_link_failed'), description, variant: 'destructive' })
        return
      }
      toast({ title: t('picker_copy_linked') })
      setCopyItem(null)
      onLinked?.()
      onClose()
    } catch {
      toast({ title: t('picker_link_failed'), variant: 'destructive' })
    } finally {
      setLinkingId(null)
    }
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return items
    return items.filter((it) =>
      `${it.supplier_name ?? ''} ${it.file_name}`.toLowerCase().includes(q),
    )
  }, [items, search])

  async function handlePick(item: AvailableInboxDoc) {
    // Select mode: the journal entry doesn't exist yet: hand the pick to the
    // parent and let it link after creation. Clear the preview first: the
    // preview dialog's open state is `previewItem !== null`, so leaving it set
    // would strand a floating preview after the picker closes (the component
    // stays mounted; the on-open reset only runs on the next open).
    if (onSelect) {
      setPreviewItem(null)
      onSelect(item)
      onClose()
      return
    }
    if (!journalEntryId) return
    setLinkingId(item.document_id)
    try {
      const res = await fetch(`/api/documents/${item.document_id}/link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          journal_entry_id: journalEntryId,
          inbox_item_id: item.inbox_item_id,
        }),
      })
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as {
          error?: string | { message?: string }
        }
          const description = json.error ? getErrorMessage(json, { locale: errorLocale }) : undefined
        toast({ title: t('picker_link_failed'), description, variant: 'destructive' })
        return
      }
      toast({ title: t('picker_linked') })
      setPreviewItem(null)
      onLinked?.()
      onClose()
    } catch {
      toast({ title: t('picker_link_failed'), variant: 'destructive' })
    } finally {
      setLinkingId(null)
    }
  }

  const linkedFiltered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return linkedItems
    // The server already matched page text; a short query narrows by name here.
    if (serverQuery) return linkedItems
    return linkedItems.filter((it) => `${it.title} ${it.file_name}`.toLowerCase().includes(q))
  }, [linkedItems, search, serverQuery])

  const hasSearch = search.trim().length > 0
  const previewSrc = previewItem ? `/api/documents/${previewItem.document_id}/inline` : null
  const copySrc = copyItem ? `/api/documents/${copyItem.document_id}/inline` : null
  const showingLinked = linkMode && source === 'linked'
  const listLoading = showingLinked ? linkedLoading : loading
  const listCount = showingLinked ? linkedFiltered.length : filtered.length

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{showingLinked ? t('picker_linked_title') : t('picker_title')}</DialogTitle>
          </DialogHeader>

          {linkMode && (
            <SegmentedControl<PickerSource>
              value={source}
              onChange={setSource}
              aria-label={t('picker_source_label')}
              options={[
                { value: 'inbox', label: t('picker_source_inbox') },
                { value: 'linked', label: t('picker_source_linked') },
              ]}
            />
          )}

          <div className="relative">
            <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={showingLinked ? t('picker_linked_search_placeholder') : t('picker_search_placeholder')}
              className="pl-9"
            />
          </div>

          {!listLoading && listCount > 0 && (
            <div className="flex justify-end px-1 text-[11px] text-muted-foreground tabular-nums">
              {t('picker_results', { count: listCount })}
            </div>
          )}

          <div className="max-h-[55vh] overflow-y-auto -mx-6 px-6 divide-y">
            {listLoading ? (
              <div className="space-y-3 py-3">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : showingLinked ? (
              linkedFiltered.length === 0 ? (
                <div className="py-10 flex flex-col items-center gap-2 text-center">
                  <DocumentTextIcon className="h-6 w-6 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">
                    {hasSearch ? t('picker_empty_search', { query: search.trim() }) : t('picker_linked_empty')}
                  </p>
                </div>
              ) : (
                linkedFiltered.map((it) => (
                  <button
                    key={it.document_id}
                    type="button"
                    onClick={() => setCopyItem(it)}
                    disabled={!!linkingId}
                    className="w-full text-left flex items-center gap-3 py-3 px-2 -ml-2 rounded-sm transition-colors hover:bg-secondary/60"
                  >
                    <DocIcon mime={null} fileName={it.file_name} />
                    <div className="flex-1 min-w-0">
                      <span data-ph-mask="" className="block text-sm font-medium truncate">{it.title}</span>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground tabular-nums">
                        {it.document_date && <span>{formatDate(it.document_date)}</span>}
                        <span data-ph-mask="" className="truncate font-normal">{it.file_name}</span>
                      </div>
                    </div>
                    {it.voucher && (
                      <span className="text-xs text-muted-foreground tabular-nums shrink-0">
                        {t('picker_on_voucher', { voucher: it.voucher })}
                      </span>
                    )}
                  </button>
                ))
              )
            ) : filtered.length === 0 ? (
              <div className="py-10 flex flex-col items-center gap-2 text-center">
                <InboxIcon className="h-6 w-6 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  {hasSearch ? t('picker_empty_search', { query: search.trim() }) : t('picker_empty')}
                </p>
              </div>
            ) : (
              filtered.map((it) => {
                const isLinking = linkingId === it.document_id
                const sourceLabel =
                  it.source === 'email' ? t('picker_source_email') : t('picker_source_upload')
                return (
                  <div key={it.inbox_item_id} className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => void handlePick(it)}
                      disabled={!!linkingId}
                      className={cn(
                        'flex-1 min-w-0 text-left flex items-center gap-3 py-3 px-2 -ml-2 rounded-sm transition-colors hover:bg-secondary/60',
                        linkingId && !isLinking && 'opacity-50',
                      )}
                    >
                      <DocIcon mime={it.mime_type} fileName={it.file_name} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-sm font-medium truncate">
                            {it.supplier_name ?? it.file_name}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground tabular-nums">
                          {it.invoice_date && <span>{formatDate(it.invoice_date)}</span>}
                          {it.supplier_name && (
                            <span className="truncate font-normal">{it.file_name}</span>
                          )}
                          <span className="shrink-0">{sourceLabel}</span>
                        </div>
                      </div>
                      {it.amount != null && (
                        <span className="text-sm font-medium tabular-nums shrink-0">
                          {formatCurrency(it.amount, it.currency ?? 'SEK')}
                        </span>
                      )}
                      {isLinking && (
                        <SpinnerIcon className="h-4 w-4 animate-spin text-muted-foreground shrink-0" />
                      )}
                    </button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="shrink-0 text-muted-foreground"
                      onClick={(e) => {
                        e.stopPropagation()
                        setPreviewItem(it)
                      }}
                    >
                      {t('picker_preview')}
                    </Button>
                  </div>
                )
              })
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={previewItem !== null} onOpenChange={(o) => !o && setPreviewItem(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            {/* data-ph-mask: the file name and supplier details are user data */}
            <DialogTitle data-ph-mask="" className="truncate pr-6">{previewItem?.file_name}</DialogTitle>
            {previewItem && (previewItem.supplier_name || previewItem.amount != null) && (
              <DialogDescription data-ph-mask="" className="flex items-center gap-2 tabular-nums">
                {previewItem.supplier_name && <span>{previewItem.supplier_name}</span>}
                {previewItem.amount != null && (
                  <span>{formatCurrency(previewItem.amount, previewItem.currency ?? 'SEK')}</span>
                )}
                {previewItem.invoice_date && <span>{formatDate(previewItem.invoice_date)}</span>}
              </DialogDescription>
            )}
          </DialogHeader>

          {previewItem && previewSrc && (
            <div className="py-1">
              <DocumentPreview
                src={previewSrc}
                kind={pickerPreviewKind(previewItem.mime_type, previewItem.file_name)}
                label={previewItem.file_name}
                className="h-[70vh] w-full rounded-lg border"
                imageClassName="max-h-[70vh] w-full rounded-lg border object-contain"
                fallback={
                  <a
                    href={previewSrc}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block px-4 py-6 text-center text-sm text-muted-foreground underline"
                  >
                    {t('picker_preview_unavailable')}
                  </a>
                }
              />
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setPreviewItem(null)}>
              {t('picker_close')}
            </Button>
            <Button
              onClick={() => {
                if (previewItem) void handlePick(previewItem)
              }}
              disabled={!!linkingId}
              loading={!!previewItem && linkingId === previewItem.document_id}
            >
              {t('picker_attach')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={copyItem !== null} onOpenChange={(o) => !o && setCopyItem(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            {/* data-ph-mask: the file name is user data */}
            <DialogTitle data-ph-mask="" className="truncate pr-6">{copyItem?.title}</DialogTitle>
            <DialogDescription>
              {copyItem?.voucher
                ? t('picker_copy_confirm', { voucher: copyItem.voucher })
                : t('picker_copy_confirm_unnumbered')}
            </DialogDescription>
          </DialogHeader>

          {copyItem && copySrc && (
            <div className="py-1">
              <DocumentPreview
                src={copySrc}
                kind={pickerPreviewKind(null, copyItem.file_name)}
                label={copyItem.file_name}
                className="h-[60vh] w-full rounded-lg border"
                imageClassName="max-h-[60vh] w-full rounded-lg border object-contain"
                fallback={
                  <a
                    href={copySrc}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block px-4 py-6 text-center text-sm text-muted-foreground underline"
                  >
                    {t('picker_preview_unavailable')}
                  </a>
                }
              />
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setCopyItem(null)}>
              {t('picker_close')}
            </Button>
            <Button
              onClick={() => {
                if (copyItem) void handleCopy(copyItem)
              }}
              disabled={!!linkingId}
              loading={!!copyItem && linkingId === copyItem.document_id}
            >
              {t('picker_copy_attach')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
