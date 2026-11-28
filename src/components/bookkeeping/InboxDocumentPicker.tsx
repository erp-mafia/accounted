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
import { Skeleton, LateReveal } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
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
import type { AvailableInboxDoc } from '@/lib/documents/inbox-available'

// InboxDocumentPicker
//
// Lists invoice-inbox documents that have not yet been consumed (no supplier
// invoice, no journal entry, not matched to a transaction, document not
// already linked) so the user can attach one as underlag to a verifikat.
//
// Three modes:
// - Link mode (JournalEntryAttachments, "Välj från inkorgen"): `journalEntryId`
//   is set and picking a document immediately links it to the journal entry AND
//   stamps the inbox item so it drops out of the active inbox: see
//   app/api/documents/[id]/link/route.ts.
// - Select mode (TransactionBookingDialog, "Välj befintligt underlag"): the
//   journal entry does not exist yet, so `onSelect` is provided instead and the
//   pick is reported to the parent, which links after the entry is created.
// - Sweep mode (JournalEntryList's bulk bar, "Koppla underlag"):
//   `journalEntryIds` names the verifikat the user selected, and one pick
//   links the document to all of them in one go: a monthly invoice or a bank
//   statement that backs several verifikat. Each verifikat goes through the
//   same POST link, in the order given: the first takes an inbox document
//   itself and every later one gets its own byte-identical copy (copy: true).
//   A document row holds one verifikat for good
//   (enforce_document_journal_entry_immutability), and nothing moves.
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

export type { AvailableInboxDoc } from '@/lib/documents/inbox-available'

interface Props {
  open: boolean
  onClose: () => void
  /** Link mode: the journal entry to link the picked document to. */
  journalEntryId?: string
  /**
   * Sweep mode: the journal entries, in order, to link the picked document
   * to (the first takes the document, the rest a copy each).
   */
  journalEntryIds?: readonly string[]
  /**
   * Link and sweep mode: called after a link with the verifikat that got the
   * document, so the parent can refresh its document list or counts.
   */
  onLinked?: (journalEntryIds: string[]) => void
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

/** Sweep mode: the document picked for every selected verifikat. */
interface SweepDoc {
  document_id: string
  file_name: string
  title: string
  mime_type: string | null
  /** The verifikat that already holds it (from "Andra verifikationer"); null for an inbox document. */
  voucher: string | null
  held: boolean
  inbox_item_id?: string
}

function DocIcon({ mime, fileName }: { mime: string | null; fileName: string }) {
  if (documentPreviewKind(mime, fileName) === 'image') {
    return <PhotoIcon className="h-4 w-4 text-muted-foreground shrink-0" />
  }
  return <DocumentTextIcon className="h-4 w-4 text-muted-foreground shrink-0" />
}

export default function InboxDocumentPicker({ open, onClose, journalEntryId, journalEntryIds, onLinked, onSelect }: Props) {
  const t = useTranslations('journal_attachments')
  const tCommon = useTranslations('common')
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
  // Sweep mode: the picked document waiting for its confirm, and how many of
  // the selected verifikat have been answered while the links run.
  const [sweepItem, setSweepItem] = useState<SweepDoc | null>(null)
  const [sweepDone, setSweepDone] = useState<number | null>(null)
  const linkMode = Boolean(journalEntryId) && !onSelect
  const sweepIds = useMemo(() => (journalEntryIds ? [...journalEntryIds] : []), [journalEntryIds])
  const sweepMode = !journalEntryId && !onSelect && sweepIds.length > 0
  // "Andra verifikationer" lists underlag the verifikat being linked do not
  // hold already: the one in link mode, every selected one in sweep mode.
  const excludedKey = (journalEntryId ? [journalEntryId] : sweepIds).join(',')

  // Reset + fetch each time the dialog opens.
  useEffect(() => {
    if (!open) return
    setSearch('')
    setItems([])
    setPreviewItem(null)
    setSource('inbox')
    setCopyItem(null)
    setSweepItem(null)
    setSweepDone(null)
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
    if (!open || source !== 'linked' || !excludedKey) return
    const excluded = new Set(excludedKey.split(','))
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
              .filter((row) => row.linked.journal_entry_id && !excluded.has(row.linked.journal_entry_id))
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
  }, [open, source, excludedKey, serverQuery])

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
      onLinked?.([journalEntryId])
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
    // Sweep mode: one document for several verifikat is confirmed first.
    if (sweepMode) {
      setPreviewItem(null)
      setSweepItem({
        document_id: item.document_id,
        file_name: item.file_name,
        title: item.supplier_name ?? item.file_name,
        mime_type: item.mime_type,
        voucher: null,
        held: false,
        inbox_item_id: item.inbox_item_id,
      })
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
      onLinked?.([journalEntryId])
      onClose()
    } catch {
      toast({ title: t('picker_link_failed'), variant: 'destructive' })
    } finally {
      setLinkingId(null)
    }
  }

  // Sweep mode: the picked document onto every selected verifikat, one link
  // per verifikat through the same route the single pick uses, one at a time.
  // An inbox document is linked itself first, without copy: if another
  // verifikat took it since the list was read, the refusal stands, as for a
  // single pick (a second verifikat on the same receipt is usually the same
  // purchase booked twice). Once it is linked, and for a document from
  // "Andra verifikationer", every verifikat gets a copy.
  async function handleSweep(doc: SweepDoc) {
    if (sweepIds.length === 0) return
    setLinkingId(doc.document_id)
    setSweepDone(0)
    // Each selected verifikat's answer: true once it holds the document or a copy.
    const outcome = new Map<string, boolean>()
    let reason: string | undefined
    const post = (id: string, copy: boolean) =>
      fetch(`/api/documents/${doc.document_id}/link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          journal_entry_id: id,
          copy,
          ...(doc.inbox_item_id && !copy ? { inbox_item_id: doc.inbox_item_id } : {}),
        }),
      })
    type LinkFailure = { error?: string | { message?: string; code?: string; details?: { current_journal_entry_id?: unknown } } }
    for (const [index, id] of sweepIds.entries()) {
      try {
        const copy = doc.held || [...outcome.values()].some(Boolean)
        let res = await post(id, copy)
        if (!res.ok) {
          const json = (await res.json().catch(() => ({}))) as LinkFailure
          const failure = typeof json.error === 'object' ? json.error : undefined
          const holder = failure?.details?.current_journal_entry_id
          // A link this sweep made whose answer was lost holds the document:
          // that verifikat has it, and this one takes a copy like the rest.
          // Held by any verifikat outside the selection, the refusal stands.
          if (!copy && failure?.code === 'DOC_LINK_ALREADY_LINKED' && typeof holder === 'string' && holder !== id && outcome.has(holder)) {
            outcome.set(holder, true)
            res = await post(id, true)
            if (!res.ok) {
              const retried = (await res.json().catch(() => ({}))) as LinkFailure
              reason ??= retried.error ? getErrorMessage(retried, { locale: errorLocale }) : undefined
            }
          } else {
            reason ??= json.error ? getErrorMessage(json, { locale: errorLocale }) : undefined
          }
        }
        outcome.set(id, res.ok)
      } catch {
        // A network failure is one verifikat not linked: counted and said in
        // the summary below, and the rest of the selection still gets its link.
        outcome.set(id, false)
      }
      setSweepDone(index + 1)
    }
    const linked = sweepIds.filter((id) => outcome.get(id) === true)
    const failed = sweepIds.length - linked.length
    setLinkingId(null)
    setSweepDone(null)
    if (failed === 0) {
      toast({ title: t('picker_sweep_done', { count: linked.length }) })
    } else {
      toast({
        title: t('picker_sweep_partial', { success: linked.length, total: sweepIds.length }),
        description: reason,
        variant: linked.length === 0 ? 'destructive' : undefined,
      })
    }
    if (linked.length === 0) return
    setSweepItem(null)
    onLinked?.(linked)
    onClose()
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
  const sweepSrc = sweepItem ? `/api/documents/${sweepItem.document_id}/inline` : null
  const offersLinked = linkMode || sweepMode
  const showingLinked = offersLinked && source === 'linked'
  const listLoading = showingLinked ? linkedLoading : loading
  const listCount = showingLinked ? linkedFiltered.length : filtered.length

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
        <DialogContent size="wide">
          <DialogHeader>
            <DialogTitle>{showingLinked ? t('picker_linked_title') : t('picker_title')}</DialogTitle>
            {sweepMode && (
              <DialogDescription>{t('picker_sweep_description', { count: sweepIds.length })}</DialogDescription>
            )}
          </DialogHeader>

          {offersLinked && (
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
            <div className="flex justify-end px-1 text-xs text-muted-foreground tabular-nums">
              {t('picker_results', { count: listCount })}
            </div>
          )}

          <div className="max-h-[55vh] overflow-y-auto -mx-6 px-6 divide-y">
            {listLoading ? (
              <LateReveal className="space-y-3 py-3">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </LateReveal>
            ) : showingLinked ? (
              linkedFiltered.length === 0 ? (
                hasSearch ? (
                  <p className="py-3 text-[13px] text-muted-foreground">
                    <span data-ph-mask="">{t('picker_empty_search', { query: search.trim() })}</span>{' '}
                    <button type="button" className={QUIET_LINK_CLASS} onClick={() => setSearch('')}>
                      {tCommon('clear_search')}
                    </button>
                  </p>
                ) : (
                  <EmptyState icon={DocumentTextIcon} title={t('picker_linked_empty')} />
                )
              ) : (
                linkedFiltered.map((it) => (
                  <button
                    key={it.document_id}
                    type="button"
                    onClick={() =>
                      sweepMode
                        ? setSweepItem({
                            document_id: it.document_id,
                            file_name: it.file_name,
                            title: it.title,
                            mime_type: null,
                            voucher: it.voucher,
                            held: true,
                          })
                        : setCopyItem(it)
                    }
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
              hasSearch ? (
                <p className="py-3 text-[13px] text-muted-foreground">
                  <span data-ph-mask="">{t('picker_empty_search', { query: search.trim() })}</span>{' '}
                  <button type="button" className={QUIET_LINK_CLASS} onClick={() => setSearch('')}>
                    {tCommon('clear_search')}
                  </button>
                </p>
              ) : (
                <EmptyState icon={InboxIcon} title={t('picker_empty')} />
              )
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
        <DialogContent size="wide">
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
                className="h-[70vh] w-full rounded-lg bg-control shadow-raised"
                imageClassName="max-h-[70vh] w-full object-contain"
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
        <DialogContent size="wide">
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
                className="h-[60vh] w-full rounded-lg bg-control shadow-raised"
                imageClassName="max-h-[60vh] w-full object-contain"
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

      <Dialog
        open={sweepItem !== null}
        onOpenChange={(o) => {
          if (!o && sweepDone === null) setSweepItem(null)
        }}
      >
        <DialogContent size="wide">
          <DialogHeader>
            {/* data-ph-mask: the file name is user data */}
            <DialogTitle data-ph-mask="" className="truncate pr-6">{sweepItem?.title}</DialogTitle>
            <DialogDescription>
              {!sweepItem?.held
                ? t('picker_sweep_confirm', { count: sweepIds.length })
                : sweepItem.voucher
                  ? t('picker_sweep_confirm_held', { count: sweepIds.length, voucher: sweepItem.voucher })
                  : t('picker_sweep_confirm_held_unnumbered', { count: sweepIds.length })}
            </DialogDescription>
          </DialogHeader>

          {sweepItem && sweepSrc && (
            <div className="py-1">
              <DocumentPreview
                src={sweepSrc}
                kind={pickerPreviewKind(sweepItem.mime_type, sweepItem.file_name)}
                label={sweepItem.file_name}
                className="h-[60vh] w-full rounded-lg bg-control shadow-raised"
                imageClassName="max-h-[60vh] w-full object-contain"
                fallback={
                  <a
                    href={sweepSrc}
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
            <Button variant="outline" onClick={() => setSweepItem(null)} disabled={sweepDone !== null}>
              {t('picker_close')}
            </Button>
            <Button
              onClick={() => {
                if (sweepItem) void handleSweep(sweepItem)
              }}
              disabled={!!linkingId}
              loading={sweepDone !== null}
            >
              {sweepDone !== null
                ? t('picker_sweep_progress', { done: sweepDone, total: sweepIds.length })
                : t('picker_sweep_attach', { count: sweepIds.length })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
