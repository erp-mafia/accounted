'use client'

import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { AttnLine } from '@/components/ui/attn-line'
import AiFilledIndicator from '@/components/ui/ai-filled-indicator'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
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
  ExternalLink,
  FileQuestion,
  Search,
  Circle,
  X,
  ChevronDown,
  Sparkles,
  MessageCircle,
} from 'lucide-react'
import Link from 'next/link'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { createClient } from '@/lib/supabase/client'
import { fetchWithTimeout } from '@/lib/http/fetch-with-timeout'
import { copyInboxAddress, type AddressCopyState } from '@/components/extensions/general/inbox-address-copy'
import { useCapability } from '@/contexts/CompanyContext'
import { CAPABILITY } from '@/lib/entitlements/keys'
import type { WorkspaceComponentProps } from '@/lib/extensions/workspace-registry'
import type { InboxChannelContext, InvoiceExtractionResult } from '@/types'
import { renderChannelParticipant } from '@/lib/documents/channel-context-notes'
import { selectInboxFields } from '@/lib/documents/inbox-field-visibility'
import BookDirectlyDialog from '@/components/extensions/general/BookDirectlyDialog'
import NewSupplierInvoiceDialog from '@/components/supplier-invoices/NewSupplierInvoiceDialog'
import BulkBookInboxDialog from '@/components/extensions/general/BulkBookInboxDialog'
// InboxCustomDomainDialog (egen domän) is built but gated off: see
// INBOX_CUSTOM_DOMAINS_ENABLED in extensions/general/invoice-inbox/index.ts.
import TransactionMatchPicker from '@/components/inbox/TransactionMatchPicker'
import { useAgentSheet } from '@/components/agent/AgentSheetProvider'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

type AccountingMethod = 'accrual' | 'cash'

// ── Types ────────────────────────────────────────────────────

interface InboxItem {
  id: string
  status: 'received' | 'error'
  source: 'email' | 'upload' | 'whatsapp'
  created_at: string
  email_from: string | null
  email_subject: string | null
  email_received_at: string | null
  // Plain-text body of the received email. Always captured, but only worth
  // showing when the mail carried no usable attachment: that is the case where
  // the body IS the content (a forwarding-confirmation code from Gmail, an
  // invoice pasted inline, a note from the sender).
  email_body_text: string | null
  document_id: string | null
  extracted_data: InvoiceExtractionResult | null
  matched_supplier_id: string | null
  matched_transaction_id: string | null
  created_supplier_invoice_id: string | null
  created_journal_entry_id: string | null
  error_message: string | null
  // True when AI extraction was skipped: either because the upload caller
  // passed skip_extraction=true (MCP/agent path) or because the server's
  // page-count gate skipped a PDF above the auto-extract limit (issue #553).
  // Distinct from status='error' (extraction failed) and from extracted_data
  // having empty fields (extraction ran but found nothing).
  extraction_skipped: boolean
  // Verified human answers from the delivering chat (source='whatsapp'):
  // photo caption, representation deltagare + syfte, sender note, and the
  // open-question state. Null/absent for email and upload items.
  channel_context?: InboxChannelContext | null
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

// How far the underlag behind the selected row got.
//
// `none` is the only state that may claim "Inget underlag bifogat": it means the
// row carries no document_id at all. A failed or hung metadata read is `error`,
// never `none`: the document exists (the row points at it), we just could not
// load it, and telling the user their underlag is missing invites a duplicate
// upload or the conclusion that the receipt is gone (BFL 7 kap 2 § retention).
type DocumentLoadState = 'none' | 'loading' | 'ready' | 'error'

// A signed-URL lookup is one indexed row plus a storage sign call: seconds at
// worst, even on a cold start. 15s leaves several times that headroom while
// still ending the spinner instead of leaving it turning forever.
const DOCUMENT_FETCH_TIMEOUT_MS = 15_000

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

// True when extraction produced at least one usable field. Distinguishes a
// deterministically-parsed underlag (fields present: render the editable
// list) from an item whose extracted_data is null/empty (AI never ran, or ran
// and found nothing). Currency is ignored because emptyExtraction() seeds it
// to 'SEK', so it is never a sign that extraction actually happened.
function hasAnyExtractedField(data: InvoiceExtractionResult | null): boolean {
  if (!data) return false
  const s = data.supplier
  const inv = data.invoice
  const t = data.totals
  return Boolean(
    s?.name || s?.orgNumber || s?.vatNumber || s?.bankgiro || s?.plusgiro ||
    inv?.invoiceNumber || inv?.invoiceDate || inv?.dueDate || inv?.paymentReference ||
    t?.subtotal != null || t?.vatAmount != null || t?.total != null ||
    (data.lineItems?.length ?? 0) > 0 || (data.vatBreakdown?.length ?? 0) > 0
  )
}

// Lifecycle stage of an inbox item. Single source of truth shared by the list
// filter, the count pills, and the row icons so they never drift apart.
//
// Precedence mirrors the FieldsRail: a booked item (supplier invoice OR a
// direct journal entry) is done and drops out of the active inbox. A
// matched-but-unbooked item is "linked": it STAYS in the inbox as its own
// category because the bank payment still needs booking (a document attached
// to a transaction is not the same as a booked one). An extraction failure is
// "error"; everything else needs a first action.
type InboxStatus = 'needs_action' | 'linked' | 'booked' | 'error'

function deriveInboxStatus(item: InboxItem): InboxStatus {
  if (item.created_supplier_invoice_id || item.created_journal_entry_id) return 'booked'
  if (item.matched_transaction_id) return 'linked'
  if (item.status === 'error') return 'error'
  return 'needs_action'
}

// ── Skeleton ─────────────────────────────────────────────────
// Mirrors the live layout (top bar + 3-pane card) so the transition from
// the route-level loading.tsx to data-loaded content has no visible reflow.
// Keep in sync with app/(dashboard)/e/[sector]/[slug]/loading.tsx.

function WorkspaceSkeleton() {
  return (
    <div className="h-[calc(100vh-1px)] md:h-full">
      <div className="h-full flex flex-col overflow-hidden">
        <header className="flex items-center justify-between gap-4 border-b px-4 py-2.5">
          <div className="flex items-center gap-2 min-w-0">
            <Skeleton className="h-4 w-4 shrink-0" />
            <Skeleton className="h-4 w-32 shrink-0" />
            <Skeleton className="hidden md:block h-3 w-56" />
          </div>
          <Skeleton className="h-8 w-28 shrink-0" />
        </header>
        <div className="flex-1 grid grid-cols-1 xl:grid-cols-[280px_minmax(0,1fr)_340px] min-h-0">
          <aside className="border-b xl:border-b-0 xl:border-r overflow-hidden bg-muted/20 pt-3">
            <div className="px-3 pb-3 space-y-2 border-b">
              <Skeleton className="h-8 w-full" />
              <div className="flex flex-wrap gap-1">
                <Skeleton className="h-5 w-10 rounded-full" />
                <Skeleton className="h-5 w-24 rounded-full" />
                <Skeleton className="h-5 w-20 rounded-full" />
                <Skeleton className="h-5 w-8 rounded-full" />
              </div>
            </div>
            <ul>
              {Array.from({ length: 7 }).map((_, i) => (
                <li key={i} className="border-b px-3 py-2 flex flex-col gap-1.5">
                  <div className="flex items-center gap-2">
                    <Skeleton className="h-3 w-3 shrink-0" />
                    <Skeleton className="h-3.5 flex-1 max-w-[180px]" />
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <Skeleton className="h-3 w-16" />
                    <Skeleton className="h-3 w-12" />
                  </div>
                </li>
              ))}
            </ul>
          </aside>
          <main className="overflow-hidden bg-muted/10 hidden xl:block" />
          <aside className="border-l overflow-hidden hidden xl:block" />
        </div>
      </div>
    </div>
  )
}

// ── Main component ───────────────────────────────────────────

export default function InvoiceInboxWorkspace(_props: WorkspaceComponentProps) {
  const { toast } = useToast()
  const t = useTranslations('inbox_workspace')
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const { openAgentSheet, identity } = useAgentSheet()

  const [items, setItems] = useState<InboxItem[]>([])
  const [isLoading, setIsLoading] = useState(true)
  // The list read failed (non-2xx, unparseable body, or network). Kept apart
  // from "the list is empty": with no list at all we know nothing about the
  // inbox and must not render an authoritative "Inkorgen är tom".
  const [itemsLoadFailed, setItemsLoadFailed] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // List filter + search (client-side over the already-fetched items list).
  // Defaults to 'todo': the active inbox (everything not yet booked), so
  // booked underlag drop out of the default view while attached-but-unbooked
  // ones stay visible.
  // 'missing' is the odd one out: it lists bank purchases, not inbox items, so
  // the list and both panes branch on it.
  const [filter, setFilter] = useState<'todo' | 'linked' | 'booked' | 'error' | 'all' | 'missing'>('todo')
  const [searchTerm, setSearchTerm] = useState('')
  // Bulk selection. Items linked to a supplier invoice are skipped at delete
  // time (server returns 409); we still allow them to be selected so the
  // user can see the "X skipped" toast and learn the rule.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [isBulkDeleting, setIsBulkDeleting] = useState(false)
  // Onboarding card visibility. Hides when all three steps are complete or
  // the user dismissed it. Persisted to localStorage so refresh doesn't
  // revive a dismissed card.
  const [onboardingDismissed, setOnboardingDismissed] = useState(false)
  // Multi-file upload progress. Null when no queue is running. Reflects the
  // sequential progress through a batch ({ total, done }) so the button can
  // show "Laddar X av N…".
  const [uploadQueue, setUploadQueue] = useState<{ total: number; done: number } | null>(null)
  const [selected, setSelected] = useState<InboxItem | null>(null)
  const [docUrl, setDocUrl] = useState<string | null>(null)
  const [docMime, setDocMime] = useState<string | null>(null)
  const [docState, setDocState] = useState<DocumentLoadState>('none')
  // Which selection the in-flight document read belongs to. The user can click
  // another row while it is running, and a late resolution must not paint its
  // outcome (a URL, or an error) onto the row that is now selected.
  const docRequestRef = useRef<string | null>(null)
  const [inboxAddress, setInboxAddress] = useState<InboxAddress | null>(null)
  // We asked for the inbox address and did not get an answer we can trust
  // (5xx, network, unparseable). Distinct from a 404, which honestly means no
  // address is provisioned yet.
  const [addressLoadFailed, setAddressLoadFailed] = useState(false)
  const [isUploading, setIsUploading] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [isRotating, setIsRotating] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [bookDirectOpen, setBookDirectOpen] = useState(false)
  // Bulk-book selected underlag (Modell B): the "Bokför valda" selection-bar
  // action. The dialog filters the selection to bookable items itself.
  const [bulkBookOpen, setBulkBookOpen] = useState(false)
  // Match-to-bank-transaction picker (opens when user clicks "Matcha mot
  // transaktion" on an unmatched inbox item).
  const [matchPickerOpen, setMatchPickerOpen] = useState(false)
  // "Skapa leverantörsfaktura" modal for the selected underlag: opens in
  // place (instead of navigating to a form page) so the user lands right back
  // here to pick the next document.
  const [createSupplierInvoiceOpen, setCreateSupplierInvoiceOpen] = useState(false)
  // Cash method users see "Bokför direkt" as the primary CTA; accrual users
  // see "Skapa leverantörsfaktura". Defaults to 'accrual' until we've read
  // the company settings so we don't flicker the CTA order on first paint.
  const [accountingMethod, setAccountingMethod] = useState<AccountingMethod>('accrual')

  // ── Data loading ───────────────────────────────────────────

  const fetchItems = useCallback(async () => {
    try {
      const res = await fetch('/api/extensions/ext/invoice-inbox/items?limit=500')
      const json = await res.json()
      if (!res.ok) {
        // No list came back, so we cannot say anything about the inbox: the
        // list column renders the failure instead of "Inkorgen är tom".
        setItemsLoadFailed(true)
        return
      }
      const serverItems: InboxItem[] = json.data?.items ?? []
      // Preserve optimistic upload placeholders that haven't resolved to a
      // server row yet. A refetch can now fire mid-upload (a realtime event
      // from an unrelated booking), and a wholesale replace would briefly
      // drop the in-flight placeholder. Placeholders carry a `temp-` id that
      // never collides with a real row, and uploadFile() removes its own
      // placeholder before its fetchItems(), so this never duplicates.
      setItems((prev) => {
        const pending = prev.filter((it) => it.isPlaceholder)
        return pending.length > 0 ? [...pending, ...serverItems] : serverItems
      })
      setItemsLoadFailed(false)
    } catch (err) {
      console.error('[invoice-inbox] fetchItems failed:', err)
      setItemsLoadFailed(true)
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
        setAddressLoadFailed(false)
        return
      }
      // 404 is the honest "no inbox provisioned yet" answer, so the activate
      // button is the right thing to offer. Anything else (503 without an
      // inbound domain, 500, an HTML error page) leaves us not knowing whether
      // an address exists, and offering "Aktivera inkorgsadress" there is not
      // just wrong copy: handleRotateAddress skips its confirm dialog when
      // inboxAddress is null, so one click would silently retire a live address
      // that suppliers and forwarding rules already point at.
      setInboxAddress(null)
      setAddressLoadFailed(res.status !== 404)
    } catch {
      setAddressLoadFailed(true)
    }
  }, [])

  useEffect(() => {
    fetchItems()
    fetchInboxAddress()
    // Resolve the company's bookkeeping method: drives CTA hierarchy.
    fetch('/api/settings')
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        const method = body?.data?.accounting_method
        if (method === 'cash' || method === 'accrual') {
          setAccountingMethod(method)
        }
      })
      .catch(() => { /* keep 'accrual' default */ })
  }, [fetchItems, fetchInboxAddress])

  // Realtime: refetch when any invoice_inbox_items row changes for this
  // company. The inbox is routinely resolved "out of band": the in-app agent
  // sheet commits a staged create_supplier_invoice_from_inbox / book-direct
  // operation, the /pending page approves one, or another tab books it, and
  // none of those paths call this component's fetchItems(). Without this, a
  // booked underlag stayed in "Att göra" until a manual reload (issue #600).
  // RLS scopes the channel to the user's company, so we never receive other
  // tenants' events; we refetch the whole list (rather than patch in place) so
  // the derived status, count pills, and ordering stay authoritative. Mirrors
  // the /pending page subscription (app/(dashboard)/pending/page.tsx).
  useEffect(() => {
    const supabase = createClient()
    const channel = supabase
      .channel('invoice_inbox_items:list')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'invoice_inbox_items' },
        () => {
          fetchItems()
        }
      )
      .subscribe()
    return () => {
      void supabase.removeChannel(channel)
    }
  }, [fetchItems])

  // Read the onboarding-dismissed flag from localStorage after mount
  // (SSR-safe: no window access during initial render).
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      setOnboardingDismissed(
        window.localStorage.getItem('gnubok.inbox.onboarding.dismissed') === '1'
      )
    } catch {
      // private browsing: keep default (show card)
    }
  }, [])

  const handleDismissOnboarding = useCallback(() => {
    try {
      window.localStorage.setItem('gnubok.inbox.onboarding.dismissed', '1')
    } catch {
      // ignore; in-memory state is enough for this session
    }
    setOnboardingDismissed(true)
  }, [])

  // Onboarding card visibility: derived from real progress so a user who
  // already has a working inbox flow never sees the guide. Once they finish
  // all three steps, the card auto-hides on next render.
  const hasInboxAddress = !!inboxAddress
  const hasAnyItem = items.length > 0
  const hasResolvedItem = items.some(
    (it) =>
      !!it.created_supplier_invoice_id ||
      !!it.matched_transaction_id ||
      !!it.created_journal_entry_id
  )
  // The list read failed and left us with nothing: we do not know whether the
  // inbox is empty. A failed refetch that still has rows on screen is not this.
  const itemsUnknown = itemsLoadFailed && !hasAnyItem
  // Never coach "ladda upp ditt första underlag" off a list we could not read:
  // that step may well be done already.
  const showOnboarding =
    !onboardingDismissed && !itemsUnknown && !(hasInboxAddress && hasAnyItem && hasResolvedItem)

  // ── List filter + search (client-side over the fetched list) ─

  // Purchases with no underlag at all. They are not inbox items and never
  // become them, so they live beside `items` rather than inside it: widening
  // InboxItem to cover a bank row would put a null document, a null extraction
  // and a null status through every consumer of that type.
  const [purchases, setPurchases] = useState<PurchaseWithoutUnderlag[]>([])
  const [selectedPurchaseId, setSelectedPurchaseId] = useState<string | null>(null)

  const fetchPurchases = useCallback(async () => {
    try {
      const res = await fetch('/api/extensions/ext/invoice-inbox/purchases')
      if (!res.ok) return
      const json = (await res.json()) as { data: { purchases: PurchaseWithoutUnderlag[] } }
      setPurchases(json.data.purchases ?? [])
    } catch {
      // A missing count is better than an error beside the user's documents.
    }
  }, [])

  useEffect(() => {
    void fetchPurchases()
  }, [fetchPurchases])

  const selectedPurchase = useMemo(
    () => purchases.find((p) => p.id === selectedPurchaseId) ?? null,
    [purchases, selectedPurchaseId],
  )

  // Per-status counts for the filter pills. Computed once over the full list.
  const statusCounts = useMemo(() => {
    const counts = { todo: 0, linked: 0, booked: 0, error: 0, all: items.length }
    for (const item of items) {
      const status = deriveInboxStatus(item)
      if (status !== 'booked') counts.todo += 1
      if (status === 'linked') counts.linked += 1
      if (status === 'booked') counts.booked += 1
      if (status === 'error') counts.error += 1
    }
    return counts
  }, [items])

  // Pills, in order. The error pill only appears when there's something errored
  // (or it's the active filter): keeps the happy-path inbox uncluttered.
  const pills = useMemo(() => {
    const list: { key: typeof filter; label: string; count: number }[] = [
      { key: 'todo', label: 'Att göra', count: statusCounts.todo },
      { key: 'linked', label: 'Kopplade', count: statusCounts.linked },
      { key: 'booked', label: 'Bokförda', count: statusCounts.booked },
    ]
    // Only worth a pill when there is something behind it: a company that
    // keeps every receipt should not be shown a permanent empty accusation.
    if (purchases.length > 0 || filter === 'missing') {
      list.push({ key: 'missing', label: 'Saknar underlag', count: purchases.length })
    }
    if (statusCounts.error > 0 || filter === 'error') {
      list.push({ key: 'error', label: 'Fel', count: statusCounts.error })
    }
    list.push({ key: 'all', label: 'Alla', count: statusCounts.all })
    return list
  }, [statusCounts, filter, purchases.length])

  const filteredPurchases = useMemo(() => {
    const term = searchTerm.trim().toLowerCase()
    if (term === '') return purchases
    return purchases.filter((p) =>
      [p.merchant_name, p.description].some((v) => v?.toLowerCase().includes(term)),
    )
  }, [purchases, searchTerm])

  const filteredItems = useMemo(() => {
    const term = searchTerm.trim().toLowerCase()
    if (filter === 'missing') return []
    return items.filter((item) => {
      // Status filter. "todo" is the active inbox: everything except booked.
      const status = deriveInboxStatus(item)
      if (filter === 'todo' && status === 'booked') return false
      if (filter === 'linked' && status !== 'linked') return false
      if (filter === 'booked' && status !== 'booked') return false
      if (filter === 'error' && status !== 'error') return false
      // 'all' → no status narrowing

      // Search filter: supplier name, email subject/from, placeholder filename
      if (term === '') return true
      const haystack = [
        item.extracted_data?.supplier?.name,
        item.email_subject,
        item.email_from,
        item.fileName,
      ]
        .filter((v): v is string => !!v)
        .join(' ')
        .toLowerCase()
      return haystack.includes(term)
    })
  }, [items, filter, searchTerm])

  // ── Selection ──────────────────────────────────────────────

  // Resolve the signed URL for a row's underlag. Every exit sets docState, so
  // the preview pane always says which of the four situations it is in: no
  // document, still loading, ready, or "we could not load it". The pane must
  // never fall back to "Inget underlag bifogat" for a row that has a
  // document_id, which is what the old silent catch produced.
  const loadDocument = useCallback(async (itemId: string, documentId: string | null) => {
    docRequestRef.current = itemId
    setDocUrl(null)
    setDocMime(null)
    if (!documentId) {
      setDocState('none')
      return
    }
    setDocState('loading')
    try {
      const res = await fetchWithTimeout(
        `/api/documents/${documentId}`,
        { method: 'GET' },
        { timeoutMs: DOCUMENT_FETCH_TIMEOUT_MS, description: `document ${documentId}` },
      )
      if (docRequestRef.current !== itemId) return
      if (!res.ok) {
        setDocState('error')
        return
      }
      const { data } = await res.json()
      if (docRequestRef.current !== itemId) return
      const url: string | null = data?.download_url ?? null
      if (!url) {
        // The document row exists but no signed URL came back: still a load
        // failure, not an absent underlag.
        setDocState('error')
        return
      }
      setDocUrl(url)
      setDocMime(data?.mime_type ?? null)
      setDocState('ready')
    } catch {
      // Timeout, offline, or an unparseable body. The document itself is
      // untouched, so the retry in the preview pane is the whole recovery.
      if (docRequestRef.current !== itemId) return
      setDocState('error')
    }
  }, [])

  const handleSelect = useCallback(async (id: string) => {
    setSelectedId(id)
    setSelectedPurchaseId(null)
    setSelected(null)
    setDocUrl(null)
    setDocMime(null)
    setDocState('none')
    docRequestRef.current = id
    // Intentionally no auto-scroll: in the vertical-stack layout (below xl)
    // scrolling the preview into view pushes the list off-screen, and the
    // user has no obvious way back to pick another item. The row-highlight
    // + the preview content update are enough feedback that the tap took.

    try {
      const res = await fetch(`/api/extensions/ext/invoice-inbox/items/${id}`)
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Kunde inte hämta posten')
      const item = json.data as InboxItem
      setSelected(item)
      await loadDocument(id, item.document_id)
    } catch (err) {
      toast({
        title: 'Kunde inte ladda dokumentet',
        description: err instanceof Error ? getUserErrorMessage(err) : 'Försök igen.',
        variant: 'destructive',
      })
    }
  }, [toast, loadDocument])

  // ── Upload ─────────────────────────────────────────────────

  // `autoSelect`: jump the detail pane to the new placeholder/row. Useful
  // for a one-off drop (user expects to see what just landed). Harmful in
  // a multi-file queue (selection yanks around as each file processes).
  const uploadFile = useCallback(async (
    file: File,
    options: { autoSelect: boolean } = { autoSelect: true },
  ) => {
    // Optimistic placeholder: gives the user an immediate visual response
    // for the 3-8s while extraction runs. Removed once the real row arrives.
    const tempId = `temp-${crypto.randomUUID()}`
    const placeholder: InboxItem = {
      id: tempId,
      status: 'received',
      source: 'upload',
      created_at: new Date().toISOString(),
      email_from: null,
      email_subject: null,
      email_received_at: null,
      email_body_text: null,
      document_id: null,
      extracted_data: null,
      matched_supplier_id: null,
      matched_transaction_id: null,
      created_supplier_invoice_id: null,
      created_journal_entry_id: null,
      error_message: null,
      extraction_skipped: false,
      isPlaceholder: true,
      fileName: file.name,
    }
    setItems((prev) => [placeholder, ...prev])
    if (options.autoSelect) {
      setSelectedId(tempId)
      setSelected(placeholder)
    }
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
      if (json.data?.extraction_skipped) {
        const pages = json.data?.page_count
        toast({
          title: 'Dokument uppladdat',
          description: pages
            ? `Stort dokument (${pages} sidor): AI-tolkning skippad. Du kan koppla det till en transaktion eller skapa leverantörsfaktura manuellt.`
            : 'AI-tolkning skippad. Du kan koppla dokumentet till en transaktion eller skapa leverantörsfaktura manuellt.',
        })
      } else {
        toast({ title: 'Dokument uppladdat', description: file.name })
      }
      setItems((prev) => prev.filter((it) => it.id !== tempId))
      await fetchItems()
      if (options.autoSelect && json.data?.inbox_item_id) {
        await handleSelect(json.data.inbox_item_id)
      }
    } catch (err) {
      setItems((prev) => prev.filter((it) => it.id !== tempId))
      if (options.autoSelect) {
        setSelectedId((prev) => (prev === tempId ? null : prev))
        setSelected((prev) => (prev?.id === tempId ? null : prev))
      }
      toast({
        title: 'Uppladdning misslyckades',
        description: err instanceof Error ? getUserErrorMessage(err) : 'Försök igen.',
        variant: 'destructive',
      })
    } finally {
      setIsUploading(false)
    }
  }, [fetchItems, handleSelect, toast])

  // Sequential queue: running multiple extractions concurrently would
  // hammer pdfjs on slow boxes. Per-file placeholder rows + the queue
  // counter on the upload button surface progress.
  const uploadFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return
    if (files.length === 1) {
      // Single-file drop: keep the historic behavior of jumping the detail
      // pane to the new item. Skip the queue counter: it would just flash.
      await uploadFile(files[0], { autoSelect: true })
      return
    }
    setUploadQueue({ total: files.length, done: 0 })
    try {
      for (const file of files) {
        await uploadFile(file, { autoSelect: false })
        setUploadQueue((q) => (q ? { ...q, done: q.done + 1 } : null))
      }
    } finally {
      setUploadQueue(null)
    }
  }, [uploadFile])

  const handleFileInputChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    if (files.length > 0) await uploadFiles(files)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }, [uploadFiles])

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    const files = Array.from(e.dataTransfer.files ?? [])
    if (files.length > 0) await uploadFiles(files)
  }, [uploadFiles])

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
        description: err instanceof Error ? getUserErrorMessage(err) : 'Försök igen.',
        variant: 'destructive',
      })
    } finally {
      setIsDeleting(false)
    }
  }, [fetchItems, selectedId, toast])

  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const clearSelection = useCallback(() => setSelectedIds(new Set()), [])

  // The selected rows, and how many of them can actually be bulk-booked
  // (matched to a transaction and not yet booked). Drives the "Bokför valda"
  // button enabled-state and feeds the bulk-book dialog.
  const selectedItems = useMemo(
    () => items.filter((it) => selectedIds.has(it.id)),
    [items, selectedIds],
  )
  const bookableSelectedCount = useMemo(
    () =>
      selectedItems.filter(
        (it) => it.matched_transaction_id && !it.created_journal_entry_id && !it.created_supplier_invoice_id,
      ).length,
    [selectedItems],
  )

  const handleBulkDelete = useCallback(async () => {
    if (selectedIds.size === 0) return
    if (!confirm(`Ta bort ${selectedIds.size} poster ur inkorgen?`)) return

    // Skip items that the server would 409 on, surface the count to the user.
    const targets = items.filter((it) => selectedIds.has(it.id))
    const deletable = targets.filter(
      (it) => !it.created_supplier_invoice_id && !it.created_journal_entry_id
    )
    const skipped = targets.length - deletable.length

    setIsBulkDeleting(true)
    try {
      const results = await Promise.allSettled(
        deletable.map((it) =>
          fetch(`/api/extensions/ext/invoice-inbox/items/${it.id}`, { method: 'DELETE' })
            .then(async (res) => {
              if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'fail')
            })
        )
      )
      const failed = results.filter((r) => r.status === 'rejected').length
      const succeeded = deletable.length - failed
      const parts: string[] = []
      if (succeeded > 0) parts.push(`${succeeded} borttagna`)
      if (skipped > 0) parts.push(`${skipped} kopplade till leverantörsfaktura, hoppade över`)
      if (failed > 0) parts.push(`${failed} misslyckades`)
      toast({
        title: 'Bulkborttagning klar',
        description: parts.join(' · '),
        variant: failed > 0 ? 'destructive' : 'default',
      })
      clearSelection()
      // If the currently-selected item was deleted, clear the rail.
      if (selectedId && deletable.some((it) => it.id === selectedId)) {
        setSelectedId(null)
        setSelected(null)
      }
      await fetchItems()
    } finally {
      setIsBulkDeleting(false)
    }
  }, [selectedIds, items, selectedId, fetchItems, toast, clearSelection])

  // ── Inbox address ──────────────────────────────────────────

  const handleRotateAddress = useCallback(async () => {
    // Confirm whenever an address may already exist: either we hold one, or the
    // read failed and we cannot rule one out. Rotating retires the old address,
    // and suppliers plus forwarding rules already point at it, so the one case
    // that must never skip this dialog is the one where we are unsure.
    if (
      (inboxAddress || addressLoadFailed) &&
      !confirm('Skapa en ny inkorgsadress? Den gamla slutar att fungera.')
    ) {
      return
    }
    setIsRotating(true)
    try {
      const res = await fetch('/api/extensions/ext/invoice-inbox/inbox/rotate', {
        method: 'POST',
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Rotation misslyckades')
      setInboxAddress(json.data)
      setAddressLoadFailed(false)
      toast({ title: 'Ny adress skapad', description: json.data.address })
    } catch (err) {
      toast({
        title: 'Rotation misslyckades',
        description: err instanceof Error ? getUserErrorMessage(err) : 'Försök igen.',
        variant: 'destructive',
      })
    } finally {
      setIsRotating(false)
    }
  }, [toast, inboxAddress, addressLoadFailed])

  // ── Render ─────────────────────────────────────────────────

  if (isLoading) return <WorkspaceSkeleton />

  return (
    <div
      className="min-h-[calc(100vh-1px)] md:min-h-full xl:h-full"
      onDragOver={(e) => { e.preventDefault(); if (!isDragging) setIsDragging(true) }}
      onDragLeave={(e) => {
        // only clear when leaving the workspace itself, not children
        if (e.currentTarget === e.target) setIsDragging(false)
      }}
      onDrop={handleDrop}
    >
    {/* No card of its own: /e/ routes render full-bleed inside the dashboard
        panel, which already supplies the border, the 12px radius and the
        background. Wrapping the workspace in a second rounded, bordered
        surface drew two frames 24px apart with mismatched radii. */}
    <div className="xl:h-full flex flex-col xl:overflow-hidden">
      {/* Top bar */}
      <header className="flex items-center justify-between gap-4 border-b px-4 py-2.5 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <Inbox className="h-4 w-4 text-muted-foreground shrink-0" />
          <h1 className="font-medium text-sm shrink-0">Dokumentinkorg</h1>
          {inboxAddress ? (
            <InboxAddressBar
              address={inboxAddress.address}
              onRotate={handleRotateAddress}
              isRotating={isRotating}
            />
          ) : addressLoadFailed ? (
            // We do not know whether an address exists, so we offer a retry
            // rather than an activate button that would rotate a live address.
            <div role="status" aria-live="polite" className="min-w-0">
              <AttnLine
                action={{ label: t('retry'), onClick: () => { void fetchInboxAddress() } }}
              >
                {t('address_load_failed')}
              </AttnLine>
            </div>
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
            multiple
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
            {uploadQueue
              ? `Laddar ${Math.min(uploadQueue.done + 1, uploadQueue.total)} av ${uploadQueue.total}…`
              : isUploading
                ? 'Laddar…'
                : 'Ladda upp'}
          </Button>
        </div>
      </header>

      {/* Three-section body. Below xl (iPad portrait/landscape + phone) the
          sections stack vertically as a single scrollable feed. With the app
          sidebar eating ~256px, even iPad landscape (1024-1180px viewport)
          has only ~570px of workspace: too tight for 3 panes. At xl+ they
          sit side-by-side as three panes. */}
      <div className="xl:flex-1 grid grid-cols-1 xl:grid-cols-[280px_minmax(0,1fr)_340px] xl:min-h-0 xl:overflow-hidden">
        {/* List: flows naturally below xl; bounded with internal scroll at xl+ */}
        <aside className="border-b xl:border-b-0 xl:border-r bg-muted/20 pt-3 xl:overflow-y-auto xl:block">
          {items.length > 0 && (
            <div className="px-3 pb-3 space-y-2 border-b">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  placeholder="Sök i inkorgen…"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-8 h-8 text-xs"
                />
              </div>
              <div className="flex flex-wrap gap-1">
                {pills.map((pill) => (
                  <button
                    key={pill.key}
                    type="button"
                    onClick={() => {
                      setFilter(pill.key)
                      // The panes show one kind of row at a time; a stale
                      // selection from the other kind would outlive its list.
                      if (pill.key === 'missing') setSelectedId(null)
                      else setSelectedPurchaseId(null)
                    }}
                    className={cn(
                      'text-[11px] px-2 py-0.5 rounded-full border transition-colors',
                      filter === pill.key
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-background text-muted-foreground border-border hover:text-foreground'
                    )}
                  >
                    {pill.label}
                    {pill.count > 0 && (
                      <span
                        className={cn(
                          'ml-1 tabular-nums',
                          filter === pill.key ? 'opacity-80' : 'opacity-50'
                        )}
                      >
                        {pill.count}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}
          {selectedIds.size > 0 && (
            <div className="sticky top-0 z-10 flex flex-col gap-3 border-b bg-background/95 backdrop-blur px-4 py-3">
              {/* Count */}
              <span className="text-xs text-muted-foreground tabular-nums">
                <span className="font-medium text-foreground">{selectedIds.size}</span>{' '}
                {selectedIds.size === 1 ? 'markerad' : 'markerade'}
              </span>
              {/* Primary action: the one solid button */}
              <Button
                variant="default"
                size="sm"
                className="h-8 w-full text-xs"
                onClick={() => setBulkBookOpen(true)}
                disabled={isBulkDeleting || bookableSelectedCount === 0}
                title={
                  bookableSelectedCount === 0
                    ? 'Inget av de valda underlagen är matchat mot en banktransaktion'
                    : undefined
                }
              >
                <Check className="h-3.5 w-3.5 mr-1.5" />
                Bokför valda
              </Button>
              {/* Secondary actions: outlined, so they read as buttons */}
              <div className="flex items-center gap-2">
                {identity.isVerified && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 flex-1 px-2 text-xs text-muted-foreground hover:text-foreground"
                    onClick={() =>
                      openAgentSheet({
                        intentId: 'inbox.bulk-book',
                        intentArgs: { item_ids: Array.from(selectedIds) },
                        contextRef: 'inbox:bulk',
                      })
                    }
                    disabled={isBulkDeleting}
                  >
                    <Sparkles className="h-3.5 w-3.5 mr-1.5" />
                    Fråga assistenten
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  className={cn(
                    'h-8 px-2 text-xs text-muted-foreground hover:text-destructive hover:border-destructive/40',
                    identity.isVerified ? 'flex-none' : 'flex-1'
                  )}
                  onClick={handleBulkDelete}
                  disabled={isBulkDeleting}
                >
                  {isBulkDeleting ? (
                    <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  ) : (
                    <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                  )}
                  Ta bort
                </Button>
              </div>
            </div>
          )}
          {itemsUnknown ? (
            // The list read failed. "Inkorgen är tom" would be a claim we
            // cannot back: a mailed-in invoice may be sitting there unread.
            <div className="p-6 text-center text-sm text-muted-foreground space-y-2">
              <AlertTriangle className="h-5 w-5 mx-auto text-attn" />
              <p>{t('items_load_failed')}</p>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={() => { void fetchItems() }}
              >
                {t('retry')}
              </Button>
            </div>
          ) : !hasAnyItem ? (
            // On desktop the preview pane is always visible alongside this
            // column, so showing the onboarding card here would duplicate it.
            // Below xl the panes stack into one feed, so the sibling preview
            // and fields panes are hidden when the inbox is empty (see their
            // classNames): this list is the only onboarding surface there.
            // So: compact card on mobile only, quiet empty state on desktop.
            showOnboarding ? (
              <>
                <div className="xl:hidden">
                  <OnboardingCard
                    hasInboxAddress={hasInboxAddress}
                    hasAnyItem={hasAnyItem}
                    hasResolvedItem={hasResolvedItem}
                    onActivateInbox={handleRotateAddress}
                    onUploadClick={() => fileInputRef.current?.click()}
                    onDismiss={handleDismissOnboarding}
                    isActivating={isRotating}
                    compact
                  />
                </div>
                <div className="hidden xl:block p-6 text-center text-sm text-muted-foreground">
                  <Inbox className="h-6 w-6 mx-auto mb-2 opacity-50" />
                  Inkorgen är tom.
                </div>
              </>
            ) : (
              <div className="p-6 text-center text-sm text-muted-foreground">
                <Inbox className="h-6 w-6 mx-auto mb-2 opacity-50" />
                Inkorgen är tom.
              </div>
            )
          ) : (filter === 'missing' ? filteredPurchases.length : filteredItems.length) === 0 ? (
            <div className="p-6 text-center text-xs text-muted-foreground">
              {filter === 'todo'
                ? 'Inget att åtgärda; allt är bearbetat.'
                : filter === 'missing'
                  ? 'Varje köp har sitt underlag.'
                  : 'Inga poster matchar filtret.'}
            </div>
          ) : (
            <ul>
              {filter === 'missing'
                ? filteredPurchases.map((p) => (
                    <PurchaseRow
                      key={p.id}
                      purchase={p}
                      selected={p.id === selectedPurchaseId}
                      onClick={() => {
                        setSelectedPurchaseId(p.id)
                        setSelectedId(null)
                      }}
                    />
                  ))
                : filteredItems.map((item) => (
                    <InboxRow
                      key={item.id}
                      item={item}
                      selected={item.id === selectedId}
                      onClick={() => handleSelect(item.id)}
                      isChecked={selectedIds.has(item.id)}
                      onToggleChecked={() => toggleSelected(item.id)}
                      anyChecked={selectedIds.size > 0}
                    />
                  ))}
            </ul>
          )}
        </aside>

        {/* Document preview (hero). When the inbox is empty there is nothing
            to preview and no row can be selected, so below xl (stacked feed)
            this pane is hidden: the list's compact onboarding card is the
            single onboarding surface, avoiding a duplicated card. */}
        <main
          className={cn(
            'xl:overflow-hidden bg-muted/10 relative xl:block min-h-[55vh] xl:min-h-0',
            !hasAnyItem && 'hidden xl:block'
          )}
        >
          {selectedPurchase ? (
            // There is no file to show, so the pane says why instead of
            // rendering an empty frame.
            <div className="h-full flex items-center justify-center p-8">
              <div className="text-center max-w-sm">
                <FileQuestion className="h-6 w-6 mx-auto mb-3 text-muted-foreground opacity-60" />
                <p className="text-sm">Inget underlag hittat</p>
                <p className="text-xs text-muted-foreground mt-1.5">
                  {selectedPurchase.portal
                    ? `${selectedPurchase.portal.vendor} skickar ingen fil. Hämta fakturan och ladda upp den här, så kopplas den till köpet.`
                    : 'Vi har sökt i brevlådorna och i portalkatalogen. Ladda upp kvittot här, eller vidarebefordra det till inkorgsadressen.'}
                </p>
              </div>
            </div>
          ) : selected ? (
            <DocumentPreview
              docUrl={docUrl}
              docMime={docMime}
              isProcessing={!!selected.isPlaceholder}
              loadState={docState}
              onRetry={() => { void loadDocument(selected.id, selected.document_id) }}
            />
          ) : showOnboarding ? (
            <div className="h-full flex items-center justify-center px-4 py-6">
              <OnboardingCard
                hasInboxAddress={hasInboxAddress}
                hasAnyItem={hasAnyItem}
                hasResolvedItem={hasResolvedItem}
                onActivateInbox={handleRotateAddress}
                onUploadClick={() => fileInputRef.current?.click()}
                onDismiss={handleDismissOnboarding}
                isActivating={isRotating}
              />
            </div>
          ) : (
            <EmptyPreview
              onUploadClick={() => fileInputRef.current?.click()}
              // Only offer activation when we know there is nothing to retire:
              // a failed address read is not a "you have no address yet".
              onActivateInbox={inboxAddress || addressLoadFailed ? null : handleRotateAddress}
              isActivating={isRotating}
            />
          )}
          {isDragging && (
            <div className="absolute inset-0 bg-primary/5 border-2 border-dashed border-primary rounded-md m-4 flex items-center justify-center pointer-events-none">
              <p className="text-sm font-medium text-primary">Släpp filen för att ladda upp</p>
            </div>
          )}
        </main>

        {/* Fields rail. Below xl it stacks below the preview as part of the
            single vertical feed (top border for separation). At xl+ it's the
            third pane with a left border. With an empty inbox no row can be
            selected, so below xl it is hidden to keep the stacked empty state
            to just the list column. */}
        <aside
          className={cn(
            'border-t xl:border-t-0 xl:border-l xl:overflow-y-auto pt-4 xl:block pb-4',
            !hasAnyItem && 'hidden xl:block'
          )}
        >
          {selectedPurchase ? (
            <PurchaseRail purchase={selectedPurchase} />
          ) : selected ? (
            <FieldsRail
              item={selected}
              docMime={docMime}
              accountingMethod={accountingMethod}
              onDelete={() => handleDelete(selected.id)}
              onBookDirect={() => setBookDirectOpen(true)}
              onCreateSupplierInvoice={() => setCreateSupplierInvoiceOpen(true)}
              onMatchTransaction={() => setMatchPickerOpen(true)}
              onUnmatchTransaction={async () => {
                const targetId = selected.id
                const res = await fetch(
                  `/api/extensions/ext/invoice-inbox/items/${targetId}/unmatch-transaction`,
                  { method: 'POST' },
                )
                if (!res.ok) {
                  const json = await res.json().catch(() => ({}))
                  toast({
                    title: 'Kunde inte avbryta matchningen',
                    description: json.error ?? `HTTP ${res.status}`,
                    variant: 'destructive',
                  })
                  return
                }
                await Promise.all([fetchItems(), handleSelect(targetId)])
              }}
              onAskAssistant={
                identity.isVerified
                  ? (transactionId) => {
                      openAgentSheet({
                        intentId: 'transaction.categorization',
                        intentArgs: { transaction_id: transactionId },
                        contextRef: `transaction:${transactionId}`,
                      })
                    }
                  : undefined
              }
              isDeleting={isDeleting}
              onRetryRequested={async () => {
                await Promise.all([fetchItems(), handleSelect(selected.id)])
              }}
              onFieldsUpdated={(nextData) => {
                // Guard against stale closure: if the user navigated to a
                // different item between sending the PATCH and the response
                // arriving, the captured `selected` is no longer the
                // currently-selected one. Without the id check we'd write
                // item A's payload onto item B's row.
                const targetId = selected.id
                setSelected((prev) =>
                  prev?.id === targetId ? { ...prev, extracted_data: nextData } : prev
                )
                setItems((prev) =>
                  prev.map((it) =>
                    it.id === targetId ? { ...it, extracted_data: nextData } : it
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
      <BookDirectlyDialog
        open={bookDirectOpen}
        onOpenChange={setBookDirectOpen}
        item={selected}
        docUrl={docUrl}
        docMime={docMime}
        onSuccess={async () => {
          await Promise.all([fetchItems(), handleSelect(selected.id)])
        }}
      />
    )}
    {selected && (
      <NewSupplierInvoiceDialog
        open={createSupplierInvoiceOpen}
        onOpenChange={setCreateSupplierInvoiceOpen}
        inboxItemId={selected.id}
        onCreated={async () => {
          // Stay in the inbox (the whole point of the modal): close, then
          // refresh the list + the selected item so it shows as converted.
          setCreateSupplierInvoiceOpen(false)
          await Promise.all([fetchItems(), handleSelect(selected.id)])
        }}
      />
    )}
    <BulkBookInboxDialog
      open={bulkBookOpen}
      onOpenChange={setBulkBookOpen}
      items={selectedItems}
      onSuccess={async () => {
        clearSelection()
        await fetchItems()
      }}
    />
    {selected && (
      <TransactionMatchPicker
        open={matchPickerOpen}
        onClose={() => setMatchPickerOpen(false)}
        inboxItemId={selected.id}
        extractedData={selected.extracted_data}
        onMatched={async () => {
          await Promise.all([fetchItems(), handleSelect(selected.id)])
        }}
      />
    )}
    </div>
  )
}


// ── Inbox address bar ────────────────────────────────────────
// The address plus its copy and rotate controls. Owns the copy state so the
// header can report an honest outcome: a clipboard write rejects for ordinary
// reasons (insecure context, a blocking Permissions-Policy, a document that
// lost focus) and the previous handler swallowed that and said "Adress
// kopierad" anyway. The user then waits for supplier invoices at an address
// they never captured, which is unrecoverable in the sense that matters: no
// invoice ever arrives and nothing explains why.
//
// Treatment mirrors CopyBlock in components/settings/ApiKeysPanel.tsx: icon
// swap for the state, one ochre AttnLine on failure, live region always
// mounted. No toast on any path, so nothing here can be evicted by (or evict)
// another toast under TOAST_LIMIT = 1.

function InboxAddressBar({
  address,
  onRotate,
  isRotating,
}: {
  address: string
  onRotate: () => void
  isRotating: boolean
}) {
  const t = useTranslations('inbox_workspace')
  const [copyState, setCopyState] = useState<AddressCopyState>('idle')

  async function handleCopy() {
    // The clipboard write is the first await, so the click's user activation
    // still holds when it runs.
    const next = await copyInboxAddress(address)
    setCopyState(next)
    if (next === 'copied') setTimeout(() => setCopyState('idle'), 2000)
  }

  return (
    <div className="flex flex-col min-w-0">
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-muted-foreground text-xs shrink-0">·</span>
        <code
          className={cn(
            'select-all font-mono text-xs text-muted-foreground min-w-0',
            // With no clipboard, reading the address off the screen is the only
            // way to get it: show it whole instead of ellipsised.
            copyState === 'failed' ? 'break-all' : 'truncate',
          )}
        >
          {address}
        </code>
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground shrink-0"
          onClick={handleCopy}
          aria-label={t('copy_address')}
          title={t('copy_address')}
        >
          {copyState === 'copied' ? (
            <Check className="h-3.5 w-3.5 text-success" />
          ) : copyState === 'failed' ? (
            <AlertTriangle className="h-3.5 w-3.5 text-attn" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
        </button>
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground shrink-0"
          onClick={onRotate}
          disabled={isRotating}
          title="Rotera till ny adress"
        >
          {isRotating ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RotateCcw className="h-3.5 w-3.5" />
          )}
        </button>
      </div>
      {/* Always mounted so the sentence is announced when it appears, not
          merely inserted. */}
      <div role="status" aria-live="polite">
        {copyState === 'failed' && (
          <AttnLine className="mt-1">{t('copy_address_failed')}</AttnLine>
        )}
      </div>
    </div>
  )
}

// ── List row ─────────────────────────────────────────────────

function InboxRow({
  item,
  selected,
  onClick,
  isChecked,
  onToggleChecked,
  anyChecked,
}: {
  item: InboxItem
  selected: boolean
  onClick: () => void
  isChecked: boolean
  onToggleChecked: () => void
  /** True when bulk-select mode is active anywhere in the list: keeps the
      checkbox visible (otherwise it's hover-only on desktop). */
  anyChecked: boolean
}) {
  const t = useTranslations('inbox_workspace')
  const amount = pickAmount(item)
  const supplierName = pickSupplierName(item)
  const isPlaceholder = !!item.isPlaceholder
  const status = deriveInboxStatus(item)
  const isErrored = status === 'error'
  const isBooked = status === 'booked'
  const isLinkedToTransaction = status === 'linked'
  // A chat question the sender never answered (48h TTL hit): the missing
  // info should be completed here instead. Quiet hint, not a status: the
  // item still books normally. Booked items drop the reminder.
  const hasUnansweredQuestion =
    !isBooked && item.channel_context?.pending_question?.status === 'moved_to_app'

  return (
    <li
      className={cn(
        'group flex items-stretch border-b transition-colors',
        selected ? 'bg-background border-l-2 border-l-primary' : 'hover:bg-background',
        isErrored && !selected && 'bg-destructive/[0.03]'
      )}
    >
      {!isPlaceholder && (
        <div
          className={cn(
            'flex items-center pl-2.5 pr-1.5 transition-opacity',
            // Always visible on touch (no hover), or when any selection is active.
            anyChecked ? 'opacity-100' : 'md:opacity-0 md:group-hover:opacity-100 opacity-100'
          )}
          onClick={(e) => e.stopPropagation()}
        >
          <Checkbox
            checked={isChecked}
            onCheckedChange={onToggleChecked}
            aria-label="Markera post"
            className="h-3.5 w-3.5"
          />
        </div>
      )}
      <button
        type="button"
        onClick={onClick}
        disabled={isPlaceholder}
        className={cn(
          'flex-1 text-left px-3 py-2 flex flex-col gap-0.5 min-w-0',
          isPlaceholder && 'cursor-default'
        )}
      >
        <div className="flex items-center gap-2 min-w-0">
          {isPlaceholder ? (
            <Loader2 className="h-3 w-3 text-muted-foreground shrink-0 animate-spin" />
          ) : item.source === 'email' ? (
            <Mail className="h-3 w-3 text-muted-foreground shrink-0" />
          ) : item.source === 'whatsapp' ? (
            <MessageCircle className="h-3 w-3 text-muted-foreground shrink-0" />
          ) : (
            <Upload className="h-3 w-3 text-muted-foreground shrink-0" />
          )}
          <span className="text-sm font-medium truncate flex-1 min-w-0">
            {isPlaceholder
              ? (item.fileName ?? 'Nytt dokument')
              : (supplierName ?? item.email_subject ?? 'Okänt dokument')}
          </span>
          {isErrored && (
            <AlertTriangle className="h-3 w-3 text-destructive shrink-0" aria-label="Fel vid bearbetning" />
          )}
          {isLinkedToTransaction && (
            <Link2 className="h-3 w-3 text-success shrink-0" aria-label="Kopplad till transaktion" />
          )}
          {isBooked && (
            <Check className="h-3 w-3 text-success shrink-0" aria-label="Bokförd" />
          )}
        </div>
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          {isPlaceholder ? (
            <span className="italic">Tolkar dokument med AI…</span>
          ) : item.extraction_skipped || hasUnansweredQuestion ? (
            <span className="flex items-center gap-1.5 min-w-0">
              {item.extraction_skipped && (
                <Badge variant="outline" className="font-normal">Inte AI-tolkad</Badge>
              )}
              {hasUnansweredQuestion && (
                <Badge variant="outline" className="font-normal text-attn border-attn/40">
                  {t('wa_question_badge')}
                </Badge>
              )}
              <span className="truncate">{timeAgo(item.email_received_at ?? item.created_at)}</span>
            </span>
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
// (placed below the row so editors can fold the row cleanly)

export function DocumentPreview({
  docUrl,
  docMime,
  isProcessing = false,
  loadState,
  onRetry,
}: {
  docUrl: string | null
  docMime: string | null
  isProcessing?: boolean
  /** Omitted by callers that only ever hold a resolved URL. */
  loadState?: DocumentLoadState
  onRetry?: () => void
}) {
  const t = useTranslations('inbox_workspace')
  const state: DocumentLoadState = loadState ?? (docUrl ? 'ready' : 'none')

  if (isProcessing) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin" />
        <span>Tolkar dokument med AI…</span>
      </div>
    )
  }
  if (state === 'loading') {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin" />
        <span>{t('document_loading')}</span>
      </div>
    )
  }
  if (state === 'error' || (state === 'ready' && !docUrl)) {
    // The row points at a stored document: say that it could not be shown, not
    // that there is nothing attached.
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 px-6 text-center text-sm text-muted-foreground">
        <AlertTriangle className="h-5 w-5 text-attn" />
        <span>{t('document_load_failed')}</span>
        {onRetry && (
          <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onRetry}>
            {t('retry')}
          </Button>
        )}
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
        <div className="max-h-full max-w-3xl bg-background rounded-md border overflow-hidden flex">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={docUrl}
            alt="Underlag"
            className="block max-h-[calc(100vh-9rem)] max-w-full w-auto h-auto object-contain"
          />
        </div>
      ) : (
        // PDF: iframe needs explicit height, frame fills the available pane.
        <div className="h-full w-full max-w-3xl bg-background rounded-md border overflow-hidden">
          <iframe src={docUrl} className="w-full h-full border-0" title="Underlag" />
        </div>
      )}
    </div>
  )
}

// ── Empty preview state ──────────────────────────────────────

// ── Onboarding card ──────────────────────────────────────────

interface OnboardingCardProps {
  hasInboxAddress: boolean
  hasAnyItem: boolean
  hasResolvedItem: boolean
  onActivateInbox: () => void
  onUploadClick: () => void
  onDismiss: () => void
  isActivating: boolean
  compact?: boolean
}

function OnboardingCard({
  hasInboxAddress,
  hasAnyItem,
  hasResolvedItem,
  onActivateInbox,
  onUploadClick,
  onDismiss,
  isActivating,
  compact = false,
}: OnboardingCardProps) {
  const steps = [
    {
      done: hasInboxAddress,
      title: 'Aktivera din inkorgsadress',
      hint: 'Få en unik e-postadress som leverantörer kan skicka fakturor och kvitton till.',
    },
    {
      done: hasAnyItem,
      title: 'Ladda upp eller maila in ett underlag',
      hint: 'Accounted tolkar fakturan eller kvittot åt dig och fyller i fält automatiskt.',
    },
    {
      done: hasResolvedItem,
      title: 'Matcha mot en transaktion eller bokför',
      hint: 'Eller skapa en manuell transaktion om underlaget saknar bankhändelse.',
    },
  ]
  // First incomplete step drives the active CTA. Falls back to -1 if all done
  // (the parent should have hidden the card by then, but guard anyway).
  const currentStep = steps.findIndex((s) => !s.done)

  return (
    <div
      className={cn(
        'relative rounded-lg border bg-card',
        compact ? 'mx-3 my-3 p-4 text-xs' : 'max-w-md mx-auto p-6'
      )}
    >
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dölj guide"
        className="absolute top-2 right-2 h-7 w-7 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
      >
        <X className="h-3.5 w-3.5" />
      </button>

      <div className={cn('space-y-1', compact ? 'pr-6' : 'pr-8')}>
        <div className="flex items-center gap-2 flex-wrap">
          <h2
            className={cn(
              'font-display tracking-tight',
              compact ? 'text-sm' : 'text-lg'
            )}
          >
            Så funkar dokumentinkorgen
          </h2>
          <Badge variant="secondary" className="text-[10px] uppercase tracking-wider">
            Beta
          </Badge>
        </div>
        <p className={cn('text-muted-foreground', compact ? 'text-[11px]' : 'text-xs')}>
          Underlagen samlas här (från mail eller filuppladdning) och kan
          matchas mot bankhändelser eller bokföras direkt. Inkorgen är alltid
          gratis; AI-tolkning av underlag ingår i abonnemanget.
        </p>
      </div>

      <ol className={cn('space-y-2.5', compact ? 'mt-3' : 'mt-5')}>
        {steps.map((step, i) => {
          const isDone = step.done
          const isCurrent = !isDone && i === currentStep
          return (
            <li
              key={step.title}
              className={cn('flex items-start gap-2.5', compact && 'gap-2')}
            >
              <span className="shrink-0 mt-0.5">
                {isDone ? (
                  <Check className={cn('text-success', compact ? 'h-3.5 w-3.5' : 'h-4 w-4')} />
                ) : isCurrent ? (
                  <span
                    className={cn(
                      'inline-flex items-center justify-center rounded-full bg-primary text-primary-foreground font-medium',
                      compact ? 'h-3.5 w-3.5 text-[9px]' : 'h-4 w-4 text-[10px]'
                    )}
                  >
                    {i + 1}
                  </span>
                ) : (
                  <Circle className={cn('text-muted-foreground/40', compact ? 'h-3.5 w-3.5' : 'h-4 w-4')} />
                )}
              </span>
              <div className="min-w-0">
                <p
                  className={cn(
                    'font-medium',
                    isDone ? 'text-muted-foreground line-through decoration-muted-foreground/40' : 'text-foreground',
                    compact ? 'text-xs' : 'text-sm'
                  )}
                >
                  {step.title}
                </p>
                {!isDone && (
                  <p
                    className={cn(
                      'text-muted-foreground mt-0.5',
                      compact ? 'text-[11px]' : 'text-xs'
                    )}
                  >
                    {step.hint}
                  </p>
                )}
              </div>
            </li>
          )
        })}
      </ol>

      {/* CTA matches the current step. No CTA for step 3: it requires the user to pick a row. */}
      {currentStep === 0 && (
        <Button
          size={compact ? 'sm' : 'default'}
          className={cn('w-full mt-4', compact && 'h-8 text-xs')}
          onClick={onActivateInbox}
          disabled={isActivating}
        >
          {isActivating ? (
            <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
          ) : (
            <Mail className="h-3.5 w-3.5 mr-1.5" />
          )}
          Aktivera inkorgsadress
        </Button>
      )}
      {currentStep === 1 && (
        <div className={cn('mt-4 space-y-2', compact && 'mt-3')}>
          <Button
            size={compact ? 'sm' : 'default'}
            className={cn('w-full', compact && 'h-8 text-xs')}
            onClick={onUploadClick}
          >
            <Upload className="h-3.5 w-3.5 mr-1.5" />
            Ladda upp en fil
          </Button>
          <p className={cn('text-center text-muted-foreground', compact ? 'text-[10px]' : 'text-[11px]')}>
            …eller maila underlagen till din inkorgsadress.
          </p>
        </div>
      )}
      {currentStep === 2 && (
        <p
          className={cn(
            'mt-4 text-center italic text-muted-foreground',
            compact ? 'text-[11px]' : 'text-xs'
          )}
        >
          Välj en post i listan för att matcha eller bokföra.
        </p>
      )}
    </div>
  )
}

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

// ── Purchases with no underlag ───────────────────────────────

/**
 * A bank purchase that has no document at all.
 *
 * These have never been on this page, because the page lists documents and a
 * purchase without one has nothing to list. They are the other half of the
 * question the receipt hunt asks, and the half a person can act on: fetch the
 * invoice from wherever the supplier keeps it, or ask whoever made the purchase.
 */
export interface PurchaseWithoutUnderlag {
  id: string
  date: string
  description: string | null
  merchant_name: string | null
  amount: number
  currency: string | null
  amount_sek: number | null
  portal: { vendor: string; url: string; note: string | null } | null
}

function PurchaseRow({
  purchase,
  selected,
  onClick,
}: {
  purchase: PurchaseWithoutUnderlag
  selected: boolean
  onClick: () => void
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className={cn(
          'w-full text-left px-3 py-2 border-b transition-colors',
          selected ? 'bg-secondary' : 'hover:bg-secondary/60',
        )}
      >
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[13px] truncate">
            {purchase.merchant_name || purchase.description || 'Okänt köp'}
          </span>
          <span className="text-xs tabular-nums shrink-0">
            {formatCurrency(Math.abs(purchase.amount), purchase.currency ?? undefined)}
          </span>
        </div>
        <div className="flex items-baseline justify-between gap-2 mt-0.5">
          <span className="text-xs text-muted-foreground tabular-nums">{formatDate(purchase.date)}</span>
          {/* A chip only when the row deviates: here, when we can actually
              tell the user where to go. */}
          {purchase.portal && (
            <Badge variant="outline" className="text-[10px] font-normal">
              {purchase.portal.vendor}
            </Badge>
          )}
        </div>
      </button>
    </li>
  )
}

function PurchaseRail({ purchase }: { purchase: PurchaseWithoutUnderlag }) {
  return (
    <div className="p-4 space-y-4">
      <div>
        <h3 className="text-sm font-medium">
          {purchase.merchant_name || purchase.description || 'Okänt köp'}
        </h3>
        <p className="text-xs text-muted-foreground mt-0.5">Köp utan underlag</p>
      </div>

      <dl className="space-y-1.5 text-xs">
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">Datum</dt>
          <dd className="tabular-nums">{formatDate(purchase.date)}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">Belopp</dt>
          <dd className="tabular-nums">
            {formatCurrency(Math.abs(purchase.amount), purchase.currency ?? undefined)}
          </dd>
        </div>
        {purchase.description && (
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground shrink-0">Kontotext</dt>
            <dd className="text-muted-foreground text-right break-words">{purchase.description}</dd>
          </div>
        )}
      </dl>

      {purchase.portal ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            {purchase.portal.note ??
              `${purchase.portal.vendor} skickar ingen fil. Fakturan ligger bakom en inloggning.`}
          </p>
          {/* We never log in for anyone. Knowing where the invoice is costs no
              password and is most of the value. */}
          <Button size="sm" className="w-full" asChild>
            <a href={purchase.portal.url} target="_blank" rel="noopener noreferrer">
              Öppna {purchase.portal.vendor}
              <ExternalLink className="h-3.5 w-3.5 ml-1.5" />
            </a>
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          Vi hittade ingen bilaga och känner inte till någon portal för den här leverantören. Ladda upp
          kvittot här, eller vidarebefordra det till inkorgsadressen.
        </p>
      )}
    </div>
  )
}

// ── Proposed kontering ───────────────────────────────────────

/**
 * What this underlag would be booked as, for a matched transaction.
 *
 * Read-only on purpose. Per convention 14 nothing AI-suggested posts without
 * review, so this shows the answer and the existing booking dialog remains the
 * only way to commit it. The lines come from the same builder the commit path
 * uses, so what is shown here is what would be posted.
 *
 * The route answers honestly when it cannot propose: a company with no rule and
 * no history, a foreign-currency row the engine would mis-VAT, a transaction
 * that already carries a verifikat. Each of those renders as a sentence rather
 * than as an empty table, because "we have nothing for this" is information.
 */
type SuggestedBooking = {
  source:
    | 'mapping_rule'
    | 'booking_template'
    | 'counterparty_template'
    | 'no_mapping'
    | 'no_transaction'
    | 'already_booked'
    | 'currency_unsupported'
  lines: { account_number: string; debit_amount: number; credit_amount: number; description: string }[]
  confidence: number | null
  requires_review?: boolean
  direction_mismatch?: boolean
  description?: string
  rule_name?: string | null
  entry_date?: string
}

const SUGGESTION_SOURCE_LABEL: Record<string, string> = {
  counterparty_template: 'Så du brukar bokföra den här leverantören',
  booking_template: 'Från en bokföringsmall',
  mapping_rule: 'Från en konteringsregel',
}

/** Why there is no proposal, said plainly rather than shown as an empty table. */
const SUGGESTION_EMPTY_REASON: Record<string, string> = {
  no_mapping:
    'Vi har inget förslag: leverantören är obekant och ingen regel matchar. Bokför manuellt en gång, så känns den igen nästa gång.',
  currency_unsupported:
    'Köpet är i utländsk valuta och matchades av en konteringsregel. Momsen skulle bli fel, så vi visar inget förslag.',
}

function ProposedBooking({ itemId }: { itemId: string }) {
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [data, setData] = useState<SuggestedBooking | null>(null)

  useEffect(() => {
    // Arrowing down a list fires one of these per row. Without the abort the
    // superseded requests still run to completion server-side, and a slow one
    // can resolve after a faster later one.
    const controller = new AbortController()
    let cancelled = false
    setState('loading')
    setData(null)
    fetch(`/api/extensions/ext/invoice-inbox/items/${itemId}/suggest-booking`, {
      method: 'POST',
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status))
        return (await res.json()) as { data: SuggestedBooking }
      })
      .then((json) => {
        if (cancelled) return
        setData(json.data)
        setState('ready')
      })
      .catch(() => {
        // A suggestion that cannot be fetched is not something the user did:
        // stay quiet rather than showing an error beside their document.
        if (!cancelled) setState('failed')
      })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [itemId])

  if (state === 'loading') return <Skeleton className="h-24 w-full" />
  if (state === 'failed' || !data) return null
  if (data.source === 'already_booked' || data.source === 'no_transaction') return null

  if (data.lines.length === 0) {
    const reason = SUGGESTION_EMPTY_REASON[data.source]
    return reason ? <p className="text-xs text-muted-foreground">{reason}</p> : null
  }

  const debit = data.lines.reduce((t, l) => t + (l.debit_amount || 0), 0)
  const credit = data.lines.reduce((t, l) => t + (l.credit_amount || 0), 0)
  const balanced = Math.round((debit - credit) * 100) === 0

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-xs font-medium">Föreslagen kontering</h3>
        {data.entry_date && (
          <span className="text-[11px] text-muted-foreground tabular-nums">
            Bokförs {formatDate(data.entry_date)}
          </span>
        )}
      </div>

      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
            <th className="pb-1 pr-2 text-left font-medium" colSpan={2}>
              Konto
            </th>
            <th className="pb-1 text-right font-medium w-20">Debet</th>
            <th className="pb-1 pl-2 text-right font-medium w-20">Kredit</th>
          </tr>
        </thead>
        <tbody>
          {data.lines.map((l, i) => (
            <tr key={`${l.account_number}-${i}`} className="border-b border-border/40 last:border-0">
              <td className="py-1 pr-2 tabular-nums text-muted-foreground w-10">{l.account_number}</td>
              <td className="py-1 pr-2 truncate" title={l.description}>
                {l.description}
              </td>
              <td className="py-1 text-right tabular-nums whitespace-nowrap w-20">
                {l.debit_amount ? formatCurrency(l.debit_amount) : ''}
              </td>
              <td className="py-1 pl-2 text-right tabular-nums whitespace-nowrap w-20 text-muted-foreground">
                {l.credit_amount ? formatCurrency(l.credit_amount) : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Balance is stated rather than assumed: the builder balances by
          construction, so a mismatch here means something upstream is wrong
          and the user should see it before booking. */}
      {!balanced && (
        <p className="text-[11px] text-warning">
          Debet {formatCurrency(debit)} · Kredit {formatCurrency(credit)}
        </p>
      )}

      {(SUGGESTION_SOURCE_LABEL[data.source] || data.requires_review || data.direction_mismatch) && (
        <details className="text-[11px] text-muted-foreground">
          <summary className="cursor-pointer hover:text-foreground">Varför så här?</summary>
          <div className="pt-1.5 space-y-1">
            {SUGGESTION_SOURCE_LABEL[data.source] && <p>{SUGGESTION_SOURCE_LABEL[data.source]}</p>}
            {data.rule_name && <p>Regel: {data.rule_name}</p>}
            {data.direction_mismatch && (
              <p className="text-warning">
                Beloppets riktning stämmer inte med hur leverantören brukar bokföras. Kontrollera innan du
                bokför.
              </p>
            )}
            {data.requires_review && !data.direction_mismatch && (
              <p>Förslaget är osäkert och bör granskas innan du bokför.</p>
            )}
          </div>
        </details>
      )}
    </div>
  )
}

// ── Fields rail ──────────────────────────────────────────────

function FieldsRail({
  item,
  docMime,
  accountingMethod,
  onDelete,
  onBookDirect,
  onCreateSupplierInvoice,
  onMatchTransaction,
  onUnmatchTransaction,
  onAskAssistant,
  isDeleting,
  onFieldsUpdated,
  onRetryRequested,
}: {
  item: InboxItem
  docMime: string | null
  accountingMethod: AccountingMethod
  onDelete: () => void
  onBookDirect: () => void
  onCreateSupplierInvoice: () => void
  onMatchTransaction: () => void
  onUnmatchTransaction: () => Promise<void>
  onAskAssistant?: (transactionId: string) => void
  isDeleting: boolean
  onFieldsUpdated: (data: InvoiceExtractionResult) => void
  onRetryRequested: () => Promise<void>
}) {
  const { toast } = useToast()
  const hasAi = useCapability(CAPABILITY.ai)
  const data = item.extracted_data
  const isProcessed = !!item.created_supplier_invoice_id
  const isBookedDirectly = !isProcessed && !!item.created_journal_entry_id
  // "Resolved" now means a journal entry exists: matched_transaction_id alone
  // is not resolved, it's the prerequisite for booking against that tx.
  const isLinkedToTransaction = !isProcessed && !isBookedDirectly && !!item.matched_transaction_id
  const isResolved = isProcessed || isBookedDirectly
  const [isUnmatchingTx, setIsUnmatchingTx] = useState(false)
  const [isRetrying, setIsRetrying] = useState(false)
  const t = useTranslations('inbox_workspace')

  // WhatsApp chat context: verified human answers captured by the intake bot
  // (photo caption, representation deltagare + syfte, sender note). Rendered
  // as read-only provenance above the editable fields, mirroring the email
  // metadata block. `moved_to_app` means the bot asked a question in the chat
  // that was never answered (48h TTL): the missing info should be completed
  // here before booking.
  const waCtx = item.source === 'whatsapp' ? item.channel_context ?? null : null
  const waParticipants = (waCtx?.representation?.participants ?? [])
    .map(renderChannelParticipant)
    .filter((n) => n.length > 0)
  const waPurpose = waCtx?.representation?.purpose?.trim() || null
  const waCaption = waCtx?.caption?.trim() || null
  const waNote = waCtx?.user_note?.trim() || null
  const waUnanswered =
    !isResolved && waCtx?.pending_question?.status === 'moved_to_app'
  const showWaBlock =
    waParticipants.length > 0 || !!waPurpose || !!waCaption || !!waNote || waUnanswered

  // Surface a quiet hint when extraction caught a supplier name but no existing
  // supplier matched. The actual creation flow lives on the leverantörsfaktura
  // form (Skapa & välj), so we don't render a separate button here.
  const extractedSupplierName = data?.supplier?.name?.trim() || null
  const showNoMatchHint =
    !isResolved &&
    !item.matched_supplier_id &&
    !!extractedSupplierName

  const handleRetry = async () => {
    // Retry overwrites extracted_data wholesale server-side, including any
    // manual field edits: make the user opt into that loss explicitly.
    if (hasAnyExtractedField(data) && !confirm(t('retry_overwrite_confirm'))) return
    setIsRetrying(true)
    try {
      const res = await fetch(
        `/api/extensions/ext/invoice-inbox/items/${item.id}/retry-extraction`,
        { method: 'POST' },
      )
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast({
          title: 'Tolkning misslyckades',
          description: json.error || 'Försök igen om en stund.',
          variant: 'destructive',
        })
        return
      }
      toast({ title: 'Tolkning lyckades' })
      await onRetryRequested()
    } finally {
      setIsRetrying(false)
    }
  }

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

      {/* WhatsApp chat context (see waCtx derivation above). */}
      {showWaBlock && (
        <div className="border-b px-4 py-3 text-xs space-y-1">
          <h3 className="text-xs uppercase tracking-wide text-muted-foreground font-medium mb-2">
            {t('wa_block_title')}
          </h3>
          {waCaption && (
            <div className="flex gap-2">
              <span className="text-muted-foreground w-20 shrink-0">{t('wa_caption_label')}</span>
              <span className="break-words min-w-0">{waCaption}</span>
            </div>
          )}
          {waParticipants.length > 0 && (
            <div className="flex gap-2">
              <span className="text-muted-foreground w-20 shrink-0">{t('wa_participants_label')}</span>
              <span className="break-words min-w-0">{waParticipants.join(', ')}</span>
            </div>
          )}
          {waPurpose && (
            <div className="flex gap-2">
              <span className="text-muted-foreground w-20 shrink-0">{t('wa_purpose_label')}</span>
              <span className="break-words min-w-0">{waPurpose}</span>
            </div>
          )}
          {waNote && (
            <div className="flex gap-2">
              <span className="text-muted-foreground w-20 shrink-0">{t('wa_note_label')}</span>
              <span className="break-words min-w-0">{waNote}</span>
            </div>
          )}
          {waUnanswered && (
            <AttnLine className="pt-1">{t('wa_question_unanswered')}</AttnLine>
          )}
        </div>
      )}

      {/* AI classification: what kind of document this is and how it was
          paid. Read-only context above the editable fields; absent for
          extractions from before the fields existed. */}
      {(data?.documentKind || data?.payment?.method || data?.pages) && (
        <div className="border-b px-4 py-3 text-xs space-y-1">
          {data?.documentKind && (
            <div className="flex gap-2">
              <span className="text-muted-foreground w-14 shrink-0">{t('doc_kind_label')}</span>
              <span>{t(`doc_kind_${data.documentKind}`)}</span>
            </div>
          )}
          {data?.payment?.method && (
            <div className="flex gap-2">
              <span className="text-muted-foreground w-14 shrink-0">{t('payment_label')}</span>
              <span>
                {t(`payment_${data.payment.method}`)}
                {data.payment.cardLast4 ? ` •• ${data.payment.cardLast4}` : ''}
                {data.purchaseTime ? ` · ${data.purchaseTime}` : ''}
              </span>
            </div>
          )}
          {data?.pages && (
            <div className="text-muted-foreground">
              {t('pages_partial_note', {
                analyzed: data.pages.analyzed,
                total: data.pages.total,
              })}
            </div>
          )}
        </div>
      )}

      {item.error_message && (
        <div className="border-b border-destructive/30 bg-destructive/5 px-4 py-3 text-xs space-y-2">
          <div className="flex items-start gap-2">
            <AlertTriangle className="h-3.5 w-3.5 text-destructive shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">Fel vid bearbetning</p>
              <p className="text-muted-foreground mt-0.5">{item.error_message}</p>
            </div>
          </div>
          {item.document_id && (
            <Button
              variant="outline"
              size="sm"
              className="w-full h-7 text-xs"
              onClick={handleRetry}
              disabled={isRetrying}
            >
              {isRetrying ? (
                <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />
              ) : (
                <RotateCcw className="h-3 w-3 mr-1.5" />
              )}
              Försök igen
            </Button>
          )}
        </div>
      )}

      {/* Mail body. Shown only when nothing was attached: then the body IS the
          delivered content, and without it the item is a dead end that says
          "no attachments" and nothing more. This is what makes a Gmail forward
          possible to set up, since Gmail sends its confirmation code as a
          plain-text mail with no attachment. Rendered as selectable text so
          the code can be copied out. */}
      {item.source === 'email' && !item.document_id && (
        <div className="border-b px-4 py-3">
          <h3 className="text-xs uppercase tracking-wide text-muted-foreground font-medium mb-2">
            {t('email_body_label')}
          </h3>
          {item.email_body_text?.trim() ? (
            <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words font-sans text-xs leading-relaxed text-foreground">
              {item.email_body_text}
            </pre>
          ) : (
            <p className="text-xs text-muted-foreground">{t('email_body_empty')}</p>
          )}
        </div>
      )}

      {/* Hint only: creation happens on the leverantörsfaktura form via "Skapa & välj" */}
      {showNoMatchHint && (
        <div className="border-b bg-muted/30 px-4 py-2 text-xs text-muted-foreground">
          Ingen leverantör matchade{' '}
          <span className="text-foreground font-medium">{extractedSupplierName}</span>
          {': leverantören skapas när du klickar Skapa leverantörsfaktura.'}
        </div>
      )}

      {/* Skipped-extraction hint: explains the empty fields and points the
          user to the manual paths (transaction link or supplier invoice).
          Deliberately reason-agnostic: skip covers sandbox, BYO-extraction
          and unsliceable PDFs, not just page count anymore. */}
      {item.extraction_skipped && !isResolved && (
        <div className="border-b bg-muted/30 px-4 py-2 text-xs text-muted-foreground">
          {t('skipped_hint')}
        </div>
      )}

      {/* HEIC: extraction ran but Bedrock cannot read the format, so every
          field came back empty with no error. Tell the user why instead of
          leaving a silently blank rail (iPhone photos default to HEIC). */}
      {!item.extraction_skipped &&
        !isResolved &&
        hasAi &&
        (docMime === 'image/heic' || docMime === 'image/heif') &&
        !hasAnyExtractedField(data) && (
          <div className="border-b bg-muted/30 px-4 py-2 text-xs text-muted-foreground">
            {t('heic_hint')}
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
        ) : !hasAnyExtractedField(data) && !hasAi ? (
          // No fields were extracted (AI never ran) and the company doesn't have
          // the AI capability. Show an upsell in place of the blank field list:
          // upload and manual entry stay available via the actions below.
          <div className="rounded-lg border border-border bg-secondary/40 px-4 py-3 text-left">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Sparkles className="h-4 w-4" />
              AI-tolkning ingår i abonnemanget
            </div>
            <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
              Uppgradera för att låta Accounted läsa av leverantör, belopp och
              moms automatiskt. Du kan fortfarande fylla i fälten manuellt eller
              koppla dokumentet till en transaktion nedan.
            </p>
            <Button size="sm" className="mt-3" asChild>
              <Link href="/settings/billing">Uppgradera</Link>
            </Button>
          </div>
        ) : (
          <EditableFieldsList
            itemId={item.id}
            data={data ?? emptyExtraction()}
            disabled={isResolved}
            onUpdated={onFieldsUpdated}
          />
        )}
      </div>

      {/* Actions: hidden while AI extraction is in flight */}
      {!item.isPlaceholder && (
      <div className="border-t px-4 py-3 space-y-2">
        {isProcessed && item.created_supplier_invoice_id ? (
          <Link href={`/supplier-invoices/${item.created_supplier_invoice_id}`} className="block">
            <Button variant="default" size="sm" className="w-full">
              <ArrowRight className="h-3.5 w-3.5 mr-1.5" />
              Öppna leverantörsfaktura
            </Button>
          </Link>
        ) : isBookedDirectly && item.created_journal_entry_id ? (
          <Link href={`/bookkeeping/${item.created_journal_entry_id}`} className="block">
            <Button variant="default" size="sm" className="w-full">
              <ArrowRight className="h-3.5 w-3.5 mr-1.5" />
              Öppna verifikation
            </Button>
          </Link>
        ) : isLinkedToTransaction && item.matched_transaction_id ? (
          <>
            {/* Matched-to-tx state: show the bridge to booking. The user
                picks one of two actions: book themselves with the
                deterministic dialog, or hand off to the assistant. */}
            <div className="rounded-md border border-success/30 bg-success/5 px-3 py-2 text-xs">
              <div className="flex items-center gap-1.5 text-success font-medium mb-1">
                <Link2 className="h-3 w-3" />
                Matchad mot transaktion
              </div>
              <Link
                href={`/transactions?highlight=${item.matched_transaction_id}`}
                className="text-muted-foreground hover:text-foreground hover:underline"
              >
                Öppna transaktionen →
              </Link>
            </div>

            {/* The answer the rail never gave: what this would be booked as.
                Read-only; booking still goes through the dialog below. */}
            <ProposedBooking itemId={item.id} />
            {onAskAssistant && (
              <Button
                variant="default"
                size="sm"
                className="w-full"
                onClick={() => onAskAssistant(item.matched_transaction_id!)}
              >
                Fråga assistenten
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={onBookDirect}
            >
              Bokför manuellt
            </Button>
            <button
              type="button"
              onClick={async () => {
                setIsUnmatchingTx(true)
                try {
                  await onUnmatchTransaction()
                } finally {
                  setIsUnmatchingTx(false)
                }
              }}
              disabled={isUnmatchingTx}
              className="w-full text-xs text-muted-foreground hover:text-foreground hover:underline pt-1"
            >
              {isUnmatchingTx ? 'Avbryter…' : 'Avbryt matchning'}
            </button>
          </>
        ) : (
          <>
            {/* Unmatched state: the canonical next step is to find the bank
                transaction this underlag belongs to. Two escape hatches sit
                below it: "Skapa leverantörsfaktura" for users who want
                supplier-invoice tracking (accrual flow), and "Bokför som
                verifikat" for underlag that aren't a supplier invoice at all
                (bank fees, owner expenses, the underlag for a correction). The
                latter opens the same BookDirectlyDialog as the matched state,
                which works without a bank transaction and lets the user attach
                one if they want. Per BFL 5 kap 6-7 § the underlag must be
                bookable as a verifikat, not forced into a supplier invoice. */}
            <Button
              variant="default"
              size="sm"
              className="w-full"
              onClick={onMatchTransaction}
            >
              Matcha mot transaktion
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="w-full justify-between">
                  Andra sätt att bokföra
                  <ChevronDown className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-64">
                <DropdownMenuItem
                  onClick={onCreateSupplierInvoice}
                  className="flex flex-col items-start gap-1"
                >
                  <span>Skapa leverantörsfaktura</span>
                  <span className="text-xs text-muted-foreground">
                    För leverantörsskulder du vill följa (periodisering).
                  </span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={onBookDirect}
                  className="flex flex-col items-start gap-1"
                >
                  <span>Bokför som verifikat</span>
                  <span className="text-xs text-muted-foreground">
                    För underlag som inte är en leverantörsfaktura (bankavgift, utlägg).
                  </span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="w-full"
          onClick={onDelete}
          disabled={isDeleting || isResolved}
          title={
            isProcessed
              ? 'Kopplad till leverantörsfaktura, kan inte tas bort'
              : isBookedDirectly
                ? 'Bokförd, kan inte tas bort'
                : isLinkedToTransaction
                  ? 'Kopplad till transaktion, koppla loss innan borttagning'
                  : undefined
          }
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
        {isBookedDirectly && (
          <Badge variant="secondary" className="w-full justify-center text-[10px]">
            <Check className="h-2.5 w-2.5 mr-1" />
            Bokförd
          </Badge>
        )}
        {isLinkedToTransaction && (
          <Badge variant="secondary" className="w-full justify-center text-[10px]">
            <Link2 className="h-2.5 w-2.5 mr-1" />
            Kopplad till transaktion
          </Badge>
        )}
      </div>
      )}
    </div>
  )
}

// ── Extracted fields list ────────────────────────────────────

export function emptyExtraction(): InvoiceExtractionResult {
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
  { key: 'invoice.currency', label: 'Valuta', type: 'text' },
  { key: 'totals.total', label: 'Totalt', type: 'number', inputMode: 'decimal' },
  { key: 'totals.vatAmount', label: 'Moms', type: 'number', inputMode: 'decimal' },
  { key: 'supplier.bankgiro', label: 'Bankgiro', type: 'text' },
  { key: 'supplier.plusgiro', label: 'Plusgiro', type: 'text' },
  { key: 'invoice.invoiceNumber', label: 'Fakturanr', type: 'text' },
  { key: 'invoice.paymentReference', label: 'OCR/Referens', type: 'text' },
  { key: 'invoice.invoiceDate', label: 'Fakturadatum', type: 'date' },
  { key: 'invoice.dueDate', label: 'Förfallodatum', type: 'date' },
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

export function EditableFieldsList({
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
  // Per-field provenance: a populated field starts "AI-filled" (its value came
  // from the extraction) and flips to user-verified once the user edits it:
  // mirrors the create form's AiFilledIndicator. Reset when switching items.
  const [edited, setEdited] = useState<Partial<Record<FieldKey, boolean>>>({})
  // Per-document fold for the invoice-only fields on a receipt.
  const [showAllFields, setShowAllFields] = useState(false)
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
    setEdited({})
    // The "Visa fakturafält" fold is per document: without this, expanding
    // it on one receipt leaves the invoice fields open on the next one,
    // which reads as if that document had them too.
    setShowAllFields(false)
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
  // matches the previous server value, i.e. the user hasn't typed anything
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
          description: err instanceof Error ? getUserErrorMessage(err) : 'Kunde inte spara',
        })
        setDrafts((prev) => ({ ...prev, [key]: readField(data, key) }))
      }
    },
    [itemId, currency, data, onUpdated, toast]
  )

  const onChange = useCallback(
    (key: FieldKey, raw: string) => {
      setDrafts((prev) => ({ ...prev, [key]: raw }))
      setEdited((prev) => (prev[key] ? prev : { ...prev, [key]: true }))
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

  const { shown: shownFields, hiddenCount } = useMemo(
    () =>
      selectInboxFields({
        documentKind: data.documentKind ?? null,
        fields: FIELD_DEFS,
        hasValue: (key) => (drafts[key as FieldKey] ?? '').trim() !== '',
        showAll: showAllFields,
      }),
    [data, drafts, showAllFields]
  )

  return (
    <div className="space-y-2">
      {shownFields.map((f) => (
        <div key={f.key} className="flex flex-col gap-0.5">
          <div className="flex items-center justify-between gap-2">
            <label
              htmlFor={`field-${f.key}`}
              className="text-[10px] uppercase tracking-wide text-muted-foreground/80"
            >
              {f.label}
            </label>
            <AiFilledIndicator
              active={drafts[f.key].trim() !== '' && !edited[f.key]}
              title="Ifyllt av AI: kontrollera mot dokumentet"
            />
          </div>
          <Input
            id={`field-${f.key}`}
            type={f.type}
            inputMode={f.inputMode}
            value={drafts[f.key]}
            onChange={(e) => onChange(f.key, e.target.value)}
            onBlur={() => onBlur(f.key)}
            disabled={disabled}
            placeholder="-"
            className={cn(
              'h-8 text-sm border-transparent bg-transparent px-2 -mx-2 hover:border-border focus-visible:border-ring',
              drafts[f.key] === '' && 'text-muted-foreground/50 italic'
            )}
          />
        </div>
      ))}
      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setShowAllFields(true)}
          className="text-[11px] text-muted-foreground hover:text-foreground hover:underline pt-1"
        >
          Visa fakturafält ({hiddenCount})
        </button>
      )}
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
          Posten är kopplad till en leverantörsfaktura: fälten kan inte ändras.
        </p>
      )}
    </div>
  )
}
