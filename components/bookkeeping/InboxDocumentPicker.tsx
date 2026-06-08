'use client'

import { useState, useEffect, useMemo } from 'react'
import { useTranslations } from 'next-intl'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Input } from '@/components/ui/input'
import { useToast } from '@/components/ui/use-toast'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { FileText, ImageIcon, Loader2, Search, Inbox, Eye } from 'lucide-react'

// InboxDocumentPicker
//
// Lists invoice-inbox documents that have not yet been consumed (no supplier
// invoice, no journal entry, not matched to a transaction, document not
// already linked) so the user can attach one as underlag to a verifikat.
//
// Two modes:
// - Link mode (JournalEntryAttachments, "Välj från inkorgen"): `journalEntryId`
//   is set and picking a document immediately links it to the journal entry AND
//   stamps the inbox item so it drops out of the active inbox — see
//   app/api/documents/[id]/link/route.ts.
// - Select mode (TransactionBookingDialog, "Välj befintligt underlag"): the
//   journal entry does not exist yet, so `onSelect` is provided instead and the
//   pick is reported to the parent, which links after the entry is created.
//
// Each row carries a preview button (eye) that opens a quick dialog rendering
// the document inline, so the user can confirm the right file before attaching.
// Attaching is the row's primary click (fast path) and is also offered from
// inside the preview dialog (preview → confirm).

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

function isImageType(type: string | null): boolean {
  return type?.startsWith('image/') ?? false
}

function isPdfType(type: string | null): boolean {
  return type === 'application/pdf'
}

function DocIcon({ mime }: { mime: string | null }) {
  if (isImageType(mime)) {
    return <ImageIcon className="h-4 w-4 text-muted-foreground shrink-0" />
  }
  return <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
}

export default function InboxDocumentPicker({ open, onClose, journalEntryId, onLinked, onSelect }: Props) {
  const t = useTranslations('journal_attachments')
  const { toast } = useToast()

  const [loading, setLoading] = useState(true)
  const [items, setItems] = useState<AvailableInboxDoc[]>([])
  const [search, setSearch] = useState('')
  const [linkingId, setLinkingId] = useState<string | null>(null)
  const [previewItem, setPreviewItem] = useState<AvailableInboxDoc | null>(null)

  // Reset + fetch each time the dialog opens.
  useEffect(() => {
    if (!open) return
    setSearch('')
    setItems([])
    setPreviewItem(null)
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

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return items
    return items.filter((it) =>
      `${it.supplier_name ?? ''} ${it.file_name}`.toLowerCase().includes(q),
    )
  }, [items, search])

  async function handlePick(item: AvailableInboxDoc) {
    // Select mode: the journal entry doesn't exist yet — hand the pick to the
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
        const description =
          typeof json.error === 'string' ? json.error : json.error?.message
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

  const hasSearch = search.trim().length > 0
  const previewSrc = previewItem ? `/api/documents/${previewItem.document_id}/inline` : null

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('picker_title')}</DialogTitle>
            <DialogDescription>{t('picker_description')}</DialogDescription>
          </DialogHeader>

          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('picker_search_placeholder')}
              className="pl-9"
            />
          </div>

          {!loading && filtered.length > 0 && (
            <div className="flex justify-end px-1 text-[11px] text-muted-foreground tabular-nums">
              {t('picker_results', { count: filtered.length })}
            </div>
          )}

          <div className="max-h-[55vh] overflow-y-auto -mx-6 px-6 divide-y">
            {loading ? (
              <div className="space-y-3 py-3">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : filtered.length === 0 ? (
              <div className="py-10 flex flex-col items-center gap-2 text-center">
                <Inbox className="h-6 w-6 text-muted-foreground" />
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
                        'flex-1 min-w-0 text-left flex items-center gap-3 py-3 px-2 -ml-2 rounded transition-colors hover:bg-secondary/60',
                        linkingId && !isLinking && 'opacity-50',
                      )}
                    >
                      <DocIcon mime={it.mime_type} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-sm font-medium truncate">
                            {it.supplier_name ?? it.file_name}
                          </span>
                          <Badge variant="outline" className="shrink-0 text-[10px]">
                            {sourceLabel}
                          </Badge>
                        </div>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground tabular-nums">
                          {it.invoice_date && <span>{formatDate(it.invoice_date)}</span>}
                          {it.supplier_name && (
                            <span className="truncate font-normal">{it.file_name}</span>
                          )}
                        </div>
                      </div>
                      {it.amount != null && (
                        <span className="text-sm font-medium tabular-nums shrink-0">
                          {formatCurrency(it.amount, it.currency ?? 'SEK')}
                        </span>
                      )}
                      {isLinking && (
                        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground shrink-0" />
                      )}
                    </button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-10 w-10 shrink-0"
                      aria-label={t('picker_preview')}
                      title={t('picker_preview')}
                      onClick={(e) => {
                        e.stopPropagation()
                        setPreviewItem(it)
                      }}
                    >
                      <Eye className="h-4 w-4" />
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
            <DialogTitle className="truncate pr-6">{previewItem?.file_name}</DialogTitle>
            {previewItem && (previewItem.supplier_name || previewItem.amount != null) && (
              <DialogDescription className="flex items-center gap-2 tabular-nums">
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
              {isImageType(previewItem.mime_type) ? (
                <img
                  src={previewSrc}
                  alt={previewItem.file_name}
                  className="max-h-[70vh] w-full rounded-lg border object-contain"
                />
              ) : isPdfType(previewItem.mime_type) ? (
                // <object> + type="application/pdf" invokes Chrome's PDF plugin
                // directly; <iframe> intermittently shows a blocked-content
                // notice even with a permissive CSP. Mirrors JournalEntryAttachments.
                <object
                  data={previewSrc}
                  type="application/pdf"
                  aria-label={previewItem.file_name}
                  className="w-full h-[70vh] rounded-lg border"
                >
                  <a
                    href={previewSrc}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block px-4 py-2 text-sm text-muted-foreground underline"
                  >
                    {t('picker_preview_unavailable')}
                  </a>
                </object>
              ) : (
                <a
                  href={previewSrc}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block px-4 py-6 text-sm text-muted-foreground underline text-center"
                >
                  {t('picker_preview_unavailable')}
                </a>
              )}
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
            >
              {previewItem && linkingId === previewItem.document_id ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('picker_attach')}
                </>
              ) : (
                t('picker_attach')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
