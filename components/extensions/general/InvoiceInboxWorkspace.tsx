'use client'

import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/use-toast'
import {
  Inbox,
  Upload,
  Mail,
  FileText,
  Copy,
  RotateCcw,
  Trash2,
  Check,
  Loader2,
  AlertTriangle,
  ArrowRight,
  Plus,
  Link2,
} from 'lucide-react'
import Link from 'next/link'
import { cn, formatCurrency } from '@/lib/utils'
import type { WorkspaceComponentProps } from '@/lib/extensions/workspace-registry'
import type { InvoiceExtractionResult } from '@/types'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'

// ── Types ────────────────────────────────────────────────────

interface InboxItem {
  id: string
  status: 'received' | 'error'
  source: 'email' | 'upload'
  created_at: string
  email_from: string | null
  email_subject: string | null
  email_received_at: string | null
  document_id: string | null
  extracted_data: InvoiceExtractionResult | null
  matched_supplier_id: string | null
  created_supplier_invoice_id: string | null
  error_message: string | null
  // Set client-side only while a manual upload is in flight. Replaced by a
  // real server-side row once the AI extraction completes.
  isPlaceholder?: boolean
  fileName?: string
}

interface InboxAddress {
  address: string
  local_part: string
  status: string
}

// ── Helpers ──────────────────────────────────────────────────

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const min = Math.floor(ms / 60000)
  if (min < 1) return 'nyss'
  if (min < 60) return `${min} min sedan`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} h sedan`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d} d sedan`
  return new Date(iso).toLocaleDateString('sv-SE')
}

function pickAmount(item: InboxItem): number | null {
  return item.extracted_data?.totals?.total ?? null
}

function pickCurrency(item: InboxItem): string {
  return item.extracted_data?.invoice?.currency ?? 'SEK'
}

function pickSupplierName(item: InboxItem): string | null {
  return item.extracted_data?.supplier?.name ?? null
}

// ── Skeleton ─────────────────────────────────────────────────

function WorkspaceSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-10 w-full" />
      <div className="grid grid-cols-[280px_minmax(0,1fr)_320px] gap-4 h-[calc(100vh-12rem)]">
        <Skeleton className="h-full" />
        <Skeleton className="h-full" />
        <Skeleton className="h-full" />
      </div>
    </div>
  )
}

// ── Main component ───────────────────────────────────────────

export default function InvoiceInboxWorkspace(_props: WorkspaceComponentProps) {
  const { toast } = useToast()
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const [items, setItems] = useState<InboxItem[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selected, setSelected] = useState<InboxItem | null>(null)
  const [docUrl, setDocUrl] = useState<string | null>(null)
  const [docMime, setDocMime] = useState<string | null>(null)
  const [inboxAddress, setInboxAddress] = useState<InboxAddress | null>(null)
  const [isUploading, setIsUploading] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [isRotating, setIsRotating] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [attachOpen, setAttachOpen] = useState(false)

  // ── Data loading ───────────────────────────────────────────

  const fetchItems = useCallback(async () => {
    try {
      const res = await fetch('/api/extensions/ext/invoice-inbox/items?limit=50')
      const json = await res.json()
      if (res.ok) setItems(json.data?.items ?? [])
    } catch (err) {
      console.error('[invoice-inbox] fetchItems failed:', err)
    } finally {
      setIsLoading(false)
    }
  }, [])

  const fetchInboxAddress = useCallback(async () => {
    try {
      const res = await fetch('/api/extensions/ext/invoice-inbox/inbox/address')
      if (res.ok) {
        const { data } = await res.json()
        setInboxAddress(data)
      }
    } catch {
      // 404 / 503 are expected when no address provisioned yet
    }
  }, [])

  useEffect(() => {
    fetchItems()
    fetchInboxAddress()
  }, [fetchItems, fetchInboxAddress])

  // ── Selection ──────────────────────────────────────────────

  const handleSelect = useCallback(async (id: string) => {
    setSelectedId(id)
    setSelected(null)
    setDocUrl(null)
    setDocMime(null)

    try {
      const res = await fetch(`/api/extensions/ext/invoice-inbox/items/${id}`)
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Kunde inte hämta posten')
      const item = json.data as InboxItem
      setSelected(item)

      if (item.document_id) {
        try {
          const docRes = await fetch(`/api/documents/${item.document_id}`)
          if (docRes.ok) {
            const { data } = await docRes.json()
            setDocUrl(data.download_url ?? null)
            setDocMime(data.mime_type ?? null)
          }
        } catch {
          // Preview is optional
        }
      }
    } catch (err) {
      toast({
        title: 'Kunde inte ladda dokumentet',
        description: err instanceof Error ? err.message : 'Försök igen.',
        variant: 'destructive',
      })
    }
  }, [toast])

  // ── Upload ─────────────────────────────────────────────────

  const uploadFile = useCallback(async (file: File) => {
    // Optimistic placeholder — gives the user an immediate visual response
    // for the 3–8s while Bedrock extracts. Removed once the real row arrives.
    const tempId = `temp-${crypto.randomUUID()}`
    const placeholder: InboxItem = {
      id: tempId,
      status: 'received',
      source: 'upload',
      created_at: new Date().toISOString(),
      email_from: null,
      email_subject: null,
      email_received_at: null,
      document_id: null,
      extracted_data: null,
      matched_supplier_id: null,
      created_supplier_invoice_id: null,
      error_message: null,
      isPlaceholder: true,
      fileName: file.name,
    }
    setItems((prev) => [placeholder, ...prev])
    setSelectedId(tempId)
    setSelected(placeholder)
    setIsUploading(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch('/api/extensions/ext/invoice-inbox/upload', {
        method: 'POST',
        body: fd,
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Uppladdning misslyckades')
      toast({ title: 'Dokument uppladdat', description: file.name })
      setItems((prev) => prev.filter((it) => it.id !== tempId))
      await fetchItems()
      if (json.data?.inbox_item_id) {
        await handleSelect(json.data.inbox_item_id)
      }
    } catch (err) {
      setItems((prev) => prev.filter((it) => it.id !== tempId))
      setSelectedId((prev) => (prev === tempId ? null : prev))
      setSelected((prev) => (prev?.id === tempId ? null : prev))
      toast({
        title: 'Uppladdning misslyckades',
        description: err instanceof Error ? err.message : 'Försök igen.',
        variant: 'destructive',
      })
    } finally {
      setIsUploading(false)
    }
  }, [fetchItems, handleSelect, toast])

  const handleFileInputChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) await uploadFile(file)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }, [uploadFile])

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    const file = e.dataTransfer.files?.[0]
    if (file) await uploadFile(file)
  }, [uploadFile])

  // ── Delete ─────────────────────────────────────────────────

  const handleDelete = useCallback(async (id: string) => {
    if (!confirm('Ta bort dokumentet ur inkorgen?')) return
    setIsDeleting(true)
    try {
      const res = await fetch(`/api/extensions/ext/invoice-inbox/items/${id}`, {
        method: 'DELETE',
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Kunde inte ta bort')
      toast({ title: 'Borttagen' })
      if (selectedId === id) {
        setSelectedId(null)
        setSelected(null)
      }
      await fetchItems()
    } catch (err) {
      toast({
        title: 'Kunde inte ta bort',
        description: err instanceof Error ? err.message : 'Försök igen.',
        variant: 'destructive',
      })
    } finally {
      setIsDeleting(false)
    }
  }, [fetchItems, selectedId, toast])

  // ── Inbox address ──────────────────────────────────────────

  const handleCopyAddress = useCallback(() => {
    if (!inboxAddress) return
    navigator.clipboard.writeText(inboxAddress.address).catch(() => {})
    toast({ title: 'Adress kopierad' })
  }, [inboxAddress, toast])

  const handleRotateAddress = useCallback(async () => {
    if (inboxAddress && !confirm('Skapa en ny inkorgsadress? Den gamla slutar att fungera.')) return
    setIsRotating(true)
    try {
      const res = await fetch('/api/extensions/ext/invoice-inbox/inbox/rotate', {
        method: 'POST',
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Rotation misslyckades')
      setInboxAddress(json.data)
      toast({ title: 'Ny adress skapad', description: json.data.address })
    } catch (err) {
      toast({
        title: 'Rotation misslyckades',
        description: err instanceof Error ? err.message : 'Försök igen.',
        variant: 'destructive',
      })
    } finally {
      setIsRotating(false)
    }
  }, [toast, inboxAddress])

  // ── Render ─────────────────────────────────────────────────

  if (isLoading) return <WorkspaceSkeleton />

  return (
    <div
      className="h-[calc(100vh-1px)] p-4 md:p-6"
      onDragOver={(e) => { e.preventDefault(); if (!isDragging) setIsDragging(true) }}
      onDragLeave={(e) => {
        // only clear when leaving the workspace itself, not children
        if (e.currentTarget === e.target) setIsDragging(false)
      }}
      onDrop={handleDrop}
    >
    <div className="h-full flex flex-col rounded-lg border bg-card overflow-hidden shadow-sm">
      {/* Top bar */}
      <header className="flex items-center justify-between gap-4 border-b px-4 py-2.5 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <Inbox className="h-4 w-4 text-muted-foreground shrink-0" />
          <h1 className="font-medium text-sm shrink-0">Dokumentinkorg</h1>
          {inboxAddress ? (
            <>
              <span className="text-muted-foreground text-xs shrink-0">·</span>
              <code className="font-mono text-xs text-muted-foreground truncate min-w-0">
                {inboxAddress.address}
              </code>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground shrink-0"
                onClick={handleCopyAddress}
                title="Kopiera adress"
              >
                <Copy className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground shrink-0"
                onClick={handleRotateAddress}
                disabled={isRotating}
                title="Rotera till ny adress"
              >
                {isRotating ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RotateCcw className="h-3.5 w-3.5" />
                )}
              </button>
            </>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={handleRotateAddress}
              disabled={isRotating}
              className="ml-2 shrink-0 h-7 text-xs"
            >
              {isRotating ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : (
                <Mail className="h-3.5 w-3.5 mr-1.5" />
              )}
              Aktivera inkorgsadress
            </Button>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf,image/jpeg,image/png,image/heic,image/heif,image/webp"
            className="hidden"
            onChange={handleFileInputChange}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={isUploading}
          >
            {isUploading ? (
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            ) : (
              <Plus className="h-3.5 w-3.5 mr-1.5" />
            )}
            Ladda upp
          </Button>
        </div>
      </header>

      {/* Three-pane body */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-[280px_minmax(0,1fr)_340px] min-h-0">
        {/* List */}
        <aside className="border-r overflow-y-auto bg-muted/20 pt-4">
          {items.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">
              <Inbox className="h-6 w-6 mx-auto mb-2 opacity-50" />
              Inkorgen är tom.
            </div>
          ) : (
            <ul>
              {items.map((item) => (
                <InboxRow
                  key={item.id}
                  item={item}
                  selected={item.id === selectedId}
                  onClick={() => handleSelect(item.id)}
                />
              ))}
            </ul>
          )}
        </aside>

        {/* Document preview (hero) */}
        <main className="overflow-hidden bg-muted/10 relative">
          {selected ? (
            <DocumentPreview docUrl={docUrl} docMime={docMime} isProcessing={!!selected.isPlaceholder} />
          ) : (
            <EmptyPreview
              onUploadClick={() => fileInputRef.current?.click()}
              onActivateInbox={inboxAddress ? null : handleRotateAddress}
              isActivating={isRotating}
            />
          )}
          {isDragging && (
            <div className="absolute inset-0 bg-primary/5 border-2 border-dashed border-primary rounded-md m-4 flex items-center justify-center pointer-events-none">
              <p className="text-sm font-medium text-primary">Släpp filen för att ladda upp</p>
            </div>
          )}
        </main>

        {/* Fields rail */}
        <aside className="border-l overflow-y-auto pt-4">
          {selected ? (
            <FieldsRail
              item={selected}
              onDelete={() => handleDelete(selected.id)}
              onAttach={() => setAttachOpen(true)}
              isDeleting={isDeleting}
              onFieldsUpdated={(nextData) => {
                setSelected((prev) => (prev ? { ...prev, extracted_data: nextData } : prev))
                setItems((prev) =>
                  prev.map((it) =>
                    it.id === selected.id ? { ...it, extracted_data: nextData } : it
                  )
                )
              }}
            />
          ) : (
            <div className="p-6 text-center text-sm text-muted-foreground">
              Välj en post för att se extraherade fält.
            </div>
          )}
        </aside>
      </div>
    </div>

    {selected && (
      <AttachToTransactionDialog
        open={attachOpen}
        onOpenChange={setAttachOpen}
        item={selected}
        onAttached={async () => {
          setAttachOpen(false)
          await fetchItems()
          toast({ title: 'Bilaga kopplad till transaktion' })
        }}
      />
    )}
    </div>
  )
}

// ── Attach-to-transaction dialog ─────────────────────────────

interface PickerTransaction {
  id: string
  date: string
  description: string
  amount: number
  currency: string
}

function AttachToTransactionDialog({
  open,
  onOpenChange,
  item,
  onAttached,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  item: InboxItem
  onAttached: () => void | Promise<void>
}) {
  const { toast } = useToast()
  const [transactions, setTransactions] = useState<PickerTransaction[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [attachingId, setAttachingId] = useState<string | null>(null)

  const targetAmount = pickAmount(item)
  const targetCurrency = pickCurrency(item)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setIsLoading(true)
    ;(async () => {
      try {
        const res = await fetch('/api/transactions?unmatched=true')
        const json = await res.json()
        if (cancelled) return
        const rows: PickerTransaction[] = (Array.isArray(json.data) ? json.data : [])
          .map((t: PickerTransaction) => ({
            id: t.id,
            date: t.date,
            description: t.description,
            amount: t.amount,
            currency: t.currency || 'SEK',
          }))
        setTransactions(rankByAmount(rows, targetAmount, targetCurrency))
      } catch (err) {
        console.error('[invoice-inbox/attach] fetch failed:', err)
        toast({ title: 'Kunde inte ladda transaktioner', variant: 'destructive' })
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [open, targetAmount, targetCurrency, toast])

  const handleAttach = async (tx: PickerTransaction) => {
    if (!item.document_id) return
    setAttachingId(tx.id)
    try {
      const res = await fetch(`/api/transactions/${tx.id}/attach-document`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ document_id: item.document_id }),
      })
      if (!res.ok) {
        const json = await res.json().catch(() => ({}))
        toast({ title: json.error || 'Kunde inte koppla bilaga', variant: 'destructive' })
        return
      }
      await onAttached()
    } finally {
      setAttachingId(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Koppla bilaga till transaktion</DialogTitle>
          <DialogDescription>
            {targetAmount != null
              ? `Belopp på fakturan: ${formatCurrency(targetAmount, pickCurrency(item))}. Listan är sorterad efter beloppsmatch.`
              : 'Välj en transaktion att koppla bilagan till.'}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto -mx-6 px-6">
          {isLoading ? (
            <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Laddar transaktioner…
            </div>
          ) : transactions.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">
              Inga okategoriserade transaktioner hittades.
            </p>
          ) : (
            <ul className="divide-y">
              {transactions.map((tx) => (
                <li key={tx.id}>
                  <button
                    type="button"
                    className="w-full flex items-center justify-between gap-4 px-1 py-3 text-left hover:bg-accent/40 disabled:opacity-50"
                    onClick={() => handleAttach(tx)}
                    disabled={attachingId !== null}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">{tx.description}</p>
                      <p className="text-xs text-muted-foreground">{tx.date}</p>
                    </div>
                    <span
                      className={cn(
                        'text-sm tabular-nums whitespace-nowrap',
                        targetAmount != null
                          && tx.currency === targetCurrency
                          && Math.abs(Math.abs(tx.amount) - Math.abs(targetAmount)) < 0.01
                          ? 'font-semibold'
                          : '',
                      )}
                    >
                      {formatCurrency(tx.amount, tx.currency)}
                    </span>
                    {attachingId === tx.id && <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function rankByAmount(
  rows: PickerTransaction[],
  target: number | null,
  targetCurrency: string,
): PickerTransaction[] {
  if (target == null) return rows
  const t = Math.abs(target)
  // Same-currency rows rank by amount distance. Cross-currency rows go to
  // the bottom — comparing a EUR invoice's amount to a SEK transaction's
  // amount numerically would be misleading and could cause a wrong attachment
  // (which then becomes verifikation underlag, BFL 5 kap 6 §). The user can
  // still manually pick a cross-currency match by scrolling down.
  return [...rows].sort((a, b) => {
    const aMatch = a.currency === targetCurrency
    const bMatch = b.currency === targetCurrency
    if (aMatch !== bMatch) return aMatch ? -1 : 1
    if (!aMatch) return 0
    const da = Math.abs(Math.abs(a.amount) - t)
    const db = Math.abs(Math.abs(b.amount) - t)
    return da - db
  })
}

// ── List row ─────────────────────────────────────────────────

function InboxRow({
  item,
  selected,
  onClick,
}: {
  item: InboxItem
  selected: boolean
  onClick: () => void
}) {
  const amount = pickAmount(item)
  const supplierName = pickSupplierName(item)
  const isErrored = item.status === 'error'
  const isProcessed = !!item.created_supplier_invoice_id
  const isPlaceholder = !!item.isPlaceholder

  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        disabled={isPlaceholder}
        className={cn(
          'w-full text-left px-3 py-2 border-b transition-colors flex flex-col gap-0.5',
          selected ? 'bg-background border-l-2 border-l-primary' : 'hover:bg-background',
          isErrored && !selected && 'bg-destructive/[0.03]',
          isPlaceholder && 'cursor-default'
        )}
      >
        <div className="flex items-center gap-2 min-w-0">
          {isPlaceholder ? (
            <Loader2 className="h-3 w-3 text-muted-foreground shrink-0 animate-spin" />
          ) : item.source === 'email' ? (
            <Mail className="h-3 w-3 text-muted-foreground shrink-0" />
          ) : (
            <Upload className="h-3 w-3 text-muted-foreground shrink-0" />
          )}
          <span className="text-sm font-medium truncate flex-1 min-w-0">
            {isPlaceholder
              ? (item.fileName ?? 'Nytt dokument')
              : (supplierName ?? item.email_subject ?? 'Okänt dokument')}
          </span>
          {isErrored && (
            <AlertTriangle className="h-3 w-3 text-destructive shrink-0" />
          )}
          {isProcessed && (
            <Check className="h-3 w-3 text-emerald-600 shrink-0" />
          )}
        </div>
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          {isPlaceholder ? (
            <span className="italic">Tolkar dokument med AI…</span>
          ) : (
            <span className="truncate">{timeAgo(item.email_received_at ?? item.created_at)}</span>
          )}
          {!isPlaceholder && amount != null && (
            <span className="tabular-nums shrink-0">
              {formatCurrency(amount, pickCurrency(item))}
            </span>
          )}
        </div>
      </button>
    </li>
  )
}

// ── Document preview pane ────────────────────────────────────

function DocumentPreview({
  docUrl,
  docMime,
  isProcessing = false,
}: {
  docUrl: string | null
  docMime: string | null
  isProcessing?: boolean
}) {
  if (isProcessing) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin" />
        <span>Tolkar dokument med AI…</span>
      </div>
    )
  }
  if (!docUrl) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
        <FileText className="h-5 w-5 mr-2" />
        Inget underlag bifogat
      </div>
    )
  }
  return (
    <div className="h-full w-full p-4 flex items-start justify-center overflow-hidden">
      {docMime?.startsWith('image/') ? (
        // Image: frame hugs the image, capped at the parent's visible box.
        <div className="max-h-full max-w-3xl bg-background rounded-md border shadow-sm overflow-hidden flex">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={docUrl}
            alt="Underlag"
            className="block max-h-[calc(100vh-9rem)] max-w-full w-auto h-auto object-contain"
          />
        </div>
      ) : (
        // PDF: iframe needs explicit height — frame fills the available pane.
        <div className="h-full w-full max-w-3xl bg-background rounded-md border shadow-sm overflow-hidden">
          <iframe src={docUrl} className="w-full h-full border-0" title="Underlag" />
        </div>
      )}
    </div>
  )
}

// ── Empty preview state ──────────────────────────────────────

function EmptyPreview({
  onUploadClick,
  onActivateInbox,
  isActivating,
}: {
  onUploadClick: () => void
  onActivateInbox: (() => void) | null
  isActivating: boolean
}) {
  return (
    <div className="h-full flex flex-col items-center justify-center text-center px-6 gap-3">
      <Inbox className="h-10 w-10 text-muted-foreground/40" />
      <div>
        <p className="text-sm font-medium">
          {onActivateInbox ? 'Aktivera din inkorgsadress' : 'Välj ett dokument från listan'}
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          {onActivateInbox
            ? 'Ditt bolag får en unik e-postadress som leverantörer kan skicka fakturor till.'
            : 'Eller dra och släpp en fil var som helst på sidan för att ladda upp.'}
        </p>
      </div>
      <div className="flex gap-2">
        {onActivateInbox && (
          <Button size="sm" onClick={onActivateInbox} disabled={isActivating}>
            {isActivating ? (
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            ) : (
              <Mail className="h-3.5 w-3.5 mr-1.5" />
            )}
            Aktivera inkorgsadress
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={onUploadClick}>
          <Plus className="h-3.5 w-3.5 mr-1.5" />
          Ladda upp en fil
        </Button>
      </div>
    </div>
  )
}

// ── Fields rail ──────────────────────────────────────────────

function FieldsRail({
  item,
  onDelete,
  onAttach,
  isDeleting,
  onFieldsUpdated,
}: {
  item: InboxItem
  onDelete: () => void
  onAttach: () => void
  isDeleting: boolean
  onFieldsUpdated: (data: InvoiceExtractionResult) => void
}) {
  const data = item.extracted_data
  const isProcessed = !!item.created_supplier_invoice_id

  return (
    <div className="flex flex-col h-full">
      {/* Email metadata */}
      {item.source === 'email' && (item.email_from || item.email_subject) && (
        <div className="border-b px-4 py-3 text-xs space-y-1">
          {item.email_from && (
            <div className="flex gap-2">
              <span className="text-muted-foreground w-14 shrink-0">Från</span>
              <span className="truncate">{item.email_from}</span>
            </div>
          )}
          {item.email_subject && (
            <div className="flex gap-2">
              <span className="text-muted-foreground w-14 shrink-0">Ämne</span>
              <span className="truncate">{item.email_subject}</span>
            </div>
          )}
          {item.email_received_at && (
            <div className="flex gap-2">
              <span className="text-muted-foreground w-14 shrink-0">Mottaget</span>
              <span>{new Date(item.email_received_at).toLocaleString('sv-SE')}</span>
            </div>
          )}
        </div>
      )}

      {item.error_message && (
        <div className="border-b border-destructive/30 bg-destructive/5 px-4 py-3 text-xs flex items-start gap-2">
          <AlertTriangle className="h-3.5 w-3.5 text-destructive shrink-0 mt-0.5" />
          <div>
            <p className="font-medium">Fel vid bearbetning</p>
            <p className="text-muted-foreground mt-0.5">{item.error_message}</p>
          </div>
        </div>
      )}

      {/* Extracted fields */}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        <h3 className="text-xs uppercase tracking-wide text-muted-foreground font-medium mb-3">
          Extraherade fält
        </h3>
        {item.isPlaceholder ? (
          <div className="space-y-2">
            <div className="text-xs text-muted-foreground italic flex items-center gap-2 mb-2">
              <Loader2 className="h-3 w-3 animate-spin" />
              Tolkar dokument med AI…
            </div>
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        ) : (
          <EditableFieldsList
            itemId={item.id}
            data={data ?? emptyExtraction()}
            disabled={isProcessed}
            onUpdated={onFieldsUpdated}
          />
        )}
      </div>

      {/* Actions — hidden while AI extraction is in flight */}
      {!item.isPlaceholder && (
      <div className="border-t px-4 py-3 space-y-2">
        {isProcessed && item.created_supplier_invoice_id ? (
          <Link href={`/supplier-invoices/${item.created_supplier_invoice_id}`} className="block">
            <Button variant="default" size="sm" className="w-full">
              <ArrowRight className="h-3.5 w-3.5 mr-1.5" />
              Öppna leverantörsfaktura
            </Button>
          </Link>
        ) : (
          <>
            <Button
              variant="default"
              size="sm"
              className="w-full"
              onClick={onAttach}
              disabled={!item.document_id}
              title={!item.document_id ? 'Ingen bilaga att koppla' : undefined}
            >
              <Link2 className="h-3.5 w-3.5 mr-1.5" />
              Koppla till transaktion
            </Button>
            <Link href={`/supplier-invoices/new?inbox_item_id=${item.id}`} className="block">
              <Button variant="outline" size="sm" className="w-full">
                Skapa leverantörsfaktura
              </Button>
            </Link>
          </>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="w-full"
          onClick={onDelete}
          disabled={isDeleting || isProcessed}
          title={isProcessed ? 'Kopplad till leverantörsfaktura — kan inte tas bort' : undefined}
        >
          {isDeleting ? (
            <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
          ) : (
            <Trash2 className="h-3.5 w-3.5 mr-1.5" />
          )}
          Ta bort
        </Button>
        {isProcessed && (
          <Badge variant="secondary" className="w-full justify-center text-[10px]">
            <Check className="h-2.5 w-2.5 mr-1" />
            Bearbetad
          </Badge>
        )}
      </div>
      )}
    </div>
  )
}

// ── Extracted fields list ────────────────────────────────────

function emptyExtraction(): InvoiceExtractionResult {
  return {
    supplier: { name: null, orgNumber: null, vatNumber: null, address: null, bankgiro: null, plusgiro: null },
    invoice: { invoiceNumber: null, invoiceDate: null, dueDate: null, paymentReference: null, currency: 'SEK' },
    lineItems: [],
    totals: { subtotal: null, vatAmount: null, total: null },
    vatBreakdown: [],
    confidence: 0,
  }
}

// Inline edit + debounced auto-save. The field set mirrors the
// UpdateExtractedDataSchema in extensions/general/invoice-inbox/index.ts.
type FieldKey =
  | 'supplier.name'
  | 'supplier.orgNumber'
  | 'supplier.vatNumber'
  | 'supplier.bankgiro'
  | 'supplier.plusgiro'
  | 'invoice.invoiceNumber'
  | 'invoice.paymentReference'
  | 'invoice.invoiceDate'
  | 'invoice.dueDate'
  | 'invoice.currency'
  | 'totals.total'
  | 'totals.vatAmount'

interface FieldDef {
  key: FieldKey
  label: string
  type: 'text' | 'date' | 'number'
  inputMode?: 'numeric' | 'decimal'
}

const FIELD_DEFS: FieldDef[] = [
  { key: 'supplier.name', label: 'Leverantör', type: 'text' },
  { key: 'supplier.orgNumber', label: 'Org.nr', type: 'text' },
  { key: 'supplier.vatNumber', label: 'VAT-nr', type: 'text' },
  { key: 'supplier.bankgiro', label: 'Bankgiro', type: 'text' },
  { key: 'supplier.plusgiro', label: 'Plusgiro', type: 'text' },
  { key: 'invoice.invoiceNumber', label: 'Fakturanr', type: 'text' },
  { key: 'invoice.paymentReference', label: 'OCR/Referens', type: 'text' },
  { key: 'invoice.invoiceDate', label: 'Fakturadatum', type: 'date' },
  { key: 'invoice.dueDate', label: 'Förfallodatum', type: 'date' },
  { key: 'invoice.currency', label: 'Valuta', type: 'text' },
  { key: 'totals.total', label: 'Totalt', type: 'number', inputMode: 'decimal' },
  { key: 'totals.vatAmount', label: 'Moms', type: 'number', inputMode: 'decimal' },
]

function readField(data: InvoiceExtractionResult, key: FieldKey): string {
  const [group, name] = key.split('.') as [keyof InvoiceExtractionResult, string]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const value = (data[group] as any)?.[name]
  if (value == null) return ''
  return String(value)
}

function buildPatchBody(key: FieldKey, raw: string, currency: string) {
  const [group, name] = key.split('.')
  const trimmed = raw.trim()

  if (group === 'totals') {
    const num = trimmed === '' ? null : Number(trimmed.replace(',', '.'))
    if (num != null && !Number.isFinite(num)) return null
    return { totals: { [name]: num } }
  }
  if (group === 'invoice' && (name === 'invoiceDate' || name === 'dueDate')) {
    const value = trimmed === '' ? null : trimmed
    return { invoice: { [name]: value } }
  }
  if (group === 'invoice' && name === 'currency') {
    return { invoice: { currency: trimmed === '' ? currency : trimmed.toUpperCase() } }
  }
  return { [group]: { [name]: trimmed === '' ? null : trimmed } }
}

function EditableFieldsList({
  itemId,
  data,
  disabled,
  onUpdated,
}: {
  itemId: string
  data: InvoiceExtractionResult
  disabled: boolean
  onUpdated: (data: InvoiceExtractionResult) => void
}) {
  const { toast } = useToast()
  const [drafts, setDrafts] = useState<Record<FieldKey, string>>(() =>
    Object.fromEntries(FIELD_DEFS.map((f) => [f.key, readField(data, f.key)])) as Record<FieldKey, string>
  )
  const timersRef = useRef<Partial<Record<FieldKey, ReturnType<typeof setTimeout>>>>({})
  // Last-known server values per field. Used to detect when the server
  // normalises a value (currency upper-cased, whitespace trimmed) so we can
  // pick up the canonical value into the input without clobbering an
  // in-progress edit.
  const lastServerRef = useRef<Record<FieldKey, string>>(
    Object.fromEntries(FIELD_DEFS.map((f) => [f.key, readField(data, f.key)])) as Record<FieldKey, string>
  )

  // Reset drafts when the user switches to a different inbox item.
  useEffect(() => {
    const seeded = Object.fromEntries(
      FIELD_DEFS.map((f) => [f.key, readField(data, f.key)])
    ) as Record<FieldKey, string>
    setDrafts(seeded)
    lastServerRef.current = seeded
    return () => {
      for (const t of Object.values(timersRef.current)) {
        if (t) clearTimeout(t)
      }
      timersRef.current = {}
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId])

  // Re-seed drafts when the server returns normalised values (e.g. uppercased
  // currency, trimmed strings). Only update fields where the local draft
  // matches the previous server value — i.e. the user hasn't typed anything
  // newer that we'd otherwise clobber.
  useEffect(() => {
    let dirty = false
    const next: Record<FieldKey, string> = { ...lastServerRef.current }
    setDrafts((prev) => {
      const updated = { ...prev }
      for (const f of FIELD_DEFS) {
        const newServer = readField(data, f.key)
        const prevServer = lastServerRef.current[f.key]
        if (newServer !== prevServer) {
          next[f.key] = newServer
          // Only sync into the input if the user hadn't started a new edit.
          if (prev[f.key] === prevServer) {
            updated[f.key] = newServer
            dirty = true
          }
        }
      }
      return dirty ? updated : prev
    })
    lastServerRef.current = next
  }, [data])

  const currency = data.invoice?.currency ?? 'SEK'

  const persist = useCallback(
    async (key: FieldKey, raw: string) => {
      const body = buildPatchBody(key, raw, currency)
      if (!body) {
        toast({ variant: 'destructive', title: 'Ogiltigt värde' })
        setDrafts((prev) => ({ ...prev, [key]: readField(data, key) }))
        return
      }
      try {
        const res = await fetch(
          `/api/extensions/ext/invoice-inbox/items/${itemId}/fields`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }
        )
        const json = await res.json()
        if (!res.ok) {
          // 409 means the item is already linked to a supplier invoice and
          // the server has rejected the edit. Surface the specific Swedish
          // message ("Posten är redan kopplad…") instead of the generic
          // fallback so the user understands why the field locked.
          const isConflict = res.status === 409
          toast({
            variant: 'destructive',
            title: isConflict ? 'Posten är låst' : 'Kunde inte spara',
            description: json.error ?? 'Försök igen',
          })
          setDrafts((prev) => ({ ...prev, [key]: readField(data, key) }))
          return
        }
        if (json.data?.extracted_data) {
          onUpdated(json.data.extracted_data as InvoiceExtractionResult)
        }
      } catch (err) {
        toast({
          variant: 'destructive',
          title: 'Nätverksfel',
          description: err instanceof Error ? err.message : 'Kunde inte spara',
        })
        setDrafts((prev) => ({ ...prev, [key]: readField(data, key) }))
      }
    },
    [itemId, currency, data, onUpdated, toast]
  )

  const onChange = useCallback(
    (key: FieldKey, raw: string) => {
      setDrafts((prev) => ({ ...prev, [key]: raw }))
      const existing = timersRef.current[key]
      if (existing) clearTimeout(existing)
      timersRef.current[key] = setTimeout(() => {
        timersRef.current[key] = undefined
        if (raw === readField(data, key)) return
        void persist(key, raw)
      }, 800)
    },
    [data, persist]
  )

  const onBlur = useCallback(
    (key: FieldKey) => {
      const pending = timersRef.current[key]
      if (pending) {
        clearTimeout(pending)
        timersRef.current[key] = undefined
        const raw = drafts[key]
        if (raw !== readField(data, key)) void persist(key, raw)
      }
    },
    [data, drafts, persist]
  )

  const vatRows = useMemo(() => data.vatBreakdown ?? [], [data.vatBreakdown])

  return (
    <div className="space-y-2">
      {FIELD_DEFS.map((f) => (
        <div key={f.key} className="flex flex-col gap-0.5">
          <label
            htmlFor={`field-${f.key}`}
            className="text-[10px] uppercase tracking-wide text-muted-foreground/80"
          >
            {f.label}
          </label>
          <Input
            id={`field-${f.key}`}
            type={f.type}
            inputMode={f.inputMode}
            value={drafts[f.key]}
            onChange={(e) => onChange(f.key, e.target.value)}
            onBlur={() => onBlur(f.key)}
            disabled={disabled}
            placeholder="—"
            className={cn(
              'h-8 text-sm border-transparent bg-transparent px-2 -mx-2 hover:border-border focus-visible:border-ring',
              drafts[f.key] === '' && 'text-muted-foreground/50 italic'
            )}
          />
        </div>
      ))}
      {vatRows.length > 0 && (
        <div className="pt-2 border-t mt-3">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground/80 mb-1.5">
            Momsfördelning
          </p>
          <div className="space-y-1">
            {vatRows.map((row, i) => (
              <div key={i} className="text-xs flex justify-between">
                <span className="text-muted-foreground">{row.rate}%</span>
                <span className="tabular-nums">
                  {formatCurrency(row.base, currency)} +{' '}
                  {formatCurrency(row.amount, currency)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
      {disabled && (
        <p className="text-[10px] text-muted-foreground/70 pt-2">
          Posten är kopplad till en leverantörsfaktura — fälten kan inte ändras.
        </p>
      )}
    </div>
  )
}
