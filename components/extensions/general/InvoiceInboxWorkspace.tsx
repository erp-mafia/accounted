'use client'

import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { useCompanySettings } from '@/lib/reference-data/hooks'
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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
  ChevronDown,
  ChevronRight,
  Sparkles,
  Maximize2,
  Globe,
} from 'lucide-react'
import Link from 'next/link'
import { cn, formatCurrency, formatDate, formatDateLong, formatDateTime } from '@/lib/utils'
import { QUIET_LINK_CLASS, CHECKBOX_REVEAL_CLASS } from '@/components/ui/dry-table'
import { useRangeSelect } from '@/lib/hooks/use-range-select'
import { GoogleMark, MicrosoftMark } from '@/components/ui/provider-marks'
import { StartCard } from '@/components/dashboard/StartCard'
import EditKonteringDialog from '@/components/extensions/general/EditKonteringDialog'
import InvoiceInboxSkeleton from '@/components/extensions/general/InvoiceInboxSkeleton'
import { WhatsAppMark } from '@/components/extensions/general/WhatsAppMark'
import { useReceiptHunt } from '@/components/extensions/general/use-receipt-hunt'
import { createClient } from '@/lib/supabase/client'
import { fetchWithTimeout } from '@/lib/http/fetch-with-timeout'
import { copyInboxAddress, type AddressCopyState } from '@/components/extensions/general/inbox-address-copy'
import { useCapability, useCompanyOptional } from '@/contexts/CompanyContext'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { useBranding } from '@/lib/branding/brand-context'
import type { WorkspaceComponentProps } from '@/lib/extensions/workspace-registry'
import type { AccountingMethod, InboxChannelContext, InvoiceExtractionResult, InboxItemSource } from '@/types'
import { renderChannelParticipant } from '@/lib/documents/channel-context-notes'
import { selectInboxFields } from '@/lib/documents/inbox-field-visibility'
import {
  matchesInboxKindFilter,
  resolveInboxKind,
  INBOX_KIND_FILTERS,
  type InboxKindFilter,
} from '@/lib/documents/inbox-kind'
import BookDirectlyDialog from '@/components/extensions/general/BookDirectlyDialog'
import NewSupplierInvoiceDialog from '@/components/supplier-invoices/NewSupplierInvoiceDialog'
import BulkBookInboxDialog from '@/components/extensions/general/BulkBookInboxDialog'
// InboxCustomDomainDialog (egen domän) is built but gated off: see
// INBOX_CUSTOM_DOMAINS_ENABLED in extensions/general/invoice-inbox/index.ts.
import TransactionMatchPicker from '@/components/inbox/TransactionMatchPicker'
import { useAgentSheet } from '@/components/agent/AgentSheetProvider'
import {
  getErrorMessage as getUserErrorMessage,
  getResponseErrorMessage,
} from '@/lib/errors/get-error-message'
import { notifySessionExpired } from '@/lib/auth/session-timeout-shared'
import {
  exceedsHostedUploadLimit,
  exceedsInboxUploadLimit,
  inboxTooLargeMessage,
} from '@/lib/documents/upload-size'
import { shrinkImageForUpload } from '@/lib/documents/shrink-image'
import { uploadViaSignedUrl } from '@/lib/documents/direct-upload'

/**
 * A failure whose message is already the sentence to show the user, resolved
 * where the response was still in hand.
 *
 * The old `throw new Error(json.error ?? '…')` lost two things. A body that
 * is not JSON (an HTML error page, an empty 502, a request rejected before it
 * reached the route) made `res.json()` itself throw, and `error` is an object
 * on the structured envelope, which stringified to "[object Object]". Both
 * ended at the generic "Något gick fel. Försök igen." An expired session on a
 * mobile tab is exactly the second shape, so the one failure the user could
 * have fixed in a tap was also the one that said the least.
 */
class ResolvedFailure extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

/**
 * Read a failed response into a displayable message, and let the session
 * controller know if the reason was an expired session (it redirects to
 * /login; the toast below is what the user sees on the way there).
 */
async function resolveFailure(response: Response): Promise<ResolvedFailure> {
  notifySessionExpired(response)
  return new ResolvedFailure(await getResponseErrorMessage(response), response.status)
}

function failureText(err: unknown): string {
  return err instanceof ResolvedFailure ? err.message : getUserErrorMessage(err)
}

/**
 * Leave a server-side trace when an upload fails.
 *
 * A request the middleware or the platform answers before the route runs
 * leaves nothing behind in the function logs, so "uploading from my phone
 * just fails" was untraceable: the successful uploads were all we could see.
 * /api/log is the existing rate-limited, PII-redacting client sink, and it is
 * the one API path exempt from the session-timeout gate, so it still records
 * the report when an expired session is the very thing being reported.
 * Metadata only, never the document.
 */
function reportUploadFailure(report: {
  status: number
  size: number
  type: string
  reason: string
}): void {
  void fetch('/api/log', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'underlag upload failed', extra: report }),
  }).catch(() => {
    // Reporting the failure must never become a second failure.
  })
}

// ── Types ────────────────────────────────────────────────────

// Mirrors the extension's UnderlagStatus: the anchoring verdict, or 'unknown'
// when the server could not read the document row. Anything but 'anchored'
// keeps the item out of the booked bucket.
type UnderlagStatus = 'anchored' | 'unlinked' | 'unlinked_locked' | 'anchored_elsewhere' | 'unknown'

interface InboxItem {
  id: string
  // 'processing' is the staged-upload in-flight state: the row exists (the
  // instant receipt ack) but the deferred AI extraction has not landed;
  // extracted_data is null until the realtime flip to 'received'.
  status: 'received' | 'processing' | 'error'
  source: InboxItemSource
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
  // Sender-declared kind from the +lev / +ver plus-address tag. A column, so
  // it survives re-extraction; wins over extracted_data.documentKind for the
  // row badge and the type filter. Absent on client-side placeholders.
  kind_hint?: 'supplier_invoice' | 'receipt' | null
  matched_supplier_id: string | null
  matched_transaction_id: string | null
  created_supplier_invoice_id: string | null
  created_journal_entry_id: string | null
  // The verifikat that anchors the matched transaction when it is already
  // booked (directly or via a bulk-book samlingsverifikat). Server-derived by
  // GET /items: created_journal_entry_id is UNIQUE per verifikat, so on a
  // samlingsverifikat only one of N items can carry the stamp; this field is
  // what lets the rest read as booked. Absent on client-side placeholders.
  matched_transaction_journal_entry_id?: string | null
  // Whether THIS item's underlag reached that verifikat (#1548). The
  // transaction being booked is a fact about the transaction, not about the
  // item's document: one whose link failed ('unlinked', transient: the daily
  // reconcile retries it), whose verifikat sits in a locked period
  // ('unlinked_locked', unlock first), that sits on another verifikat
  // ('anchored_elsewhere', a human decision), or that could not be read
  // ('unknown') keeps the item in "Att göra". null when nothing was derived
  // (no booked matched transaction, or the item is stamped). Absent on
  // client-side placeholders.
  underlag_status?: UnderlagStatus | null
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

// One received mail per inbox, from the InboundMailReceived history event
// the inbound webhook appends (#2181). Sender, subject and address are
// deliberately absent from the event (processing_history is outside the
// erasure path); the route resolves inbox_id to the company's own address
// at read time, and the filed item ids are what the panel links to.
interface InboundMailAttachment {
  id: string
  outcome: 'filed' | 'duplicate' | 'rejected' | 'failed'
  inbox_item_id?: string
  reason?: string
  mime?: string
}
interface InboundMail {
  event_id: string
  email_id: string
  occurred_at: string
  inbox_id: string | null
  custom_domain: boolean
  tags: string[]
  unknown_tag_count: number
  inbox_local_part: string | null
  inbox_status: string | null
  kind_hint: string | null
  tag_conflict: boolean
  outcome: string
  attachment_count: number
  inbox_item_id: string | null
  attachments: InboundMailAttachment[]
}
// Window for the received-mail panel; the route caps at 365.
const INBOUND_MAIL_DAYS = 30

// `acme-x7f2@inbox.example` + 'lev' → `acme-x7f2+lev@inbox.example`. The
// webhook splits the local part at the first `+` and looks up what is before
// it, so the tag never changes which company the mail reaches.
function plusAddress(address: string, tag: string): string {
  const at = address.indexOf('@')
  if (at === -1) return address
  return `${address.slice(0, at)}+${tag}${address.slice(at)}`
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
  const total = item.extracted_data?.totals?.total
  if (total != null) return total
  // Non-invoice documents (bankintyg, avtal) have no total; when exactly one
  // distinct amount was read off the document, that is the amount to show.
  // Two or more stay ambiguous and render as no amount.
  const distinct = [
    ...new Set(
      (item.extracted_data?.prominentAmounts ?? [])
        .map((a) => a.amount)
        .filter((a) => Number.isFinite(a) && a !== 0),
    ),
  ]
  return distinct.length === 1 ? distinct[0] : null
}

function pickCurrency(item: InboxItem): string {
  return item.extracted_data?.invoice?.currency ?? 'SEK'
}

function pickSupplierName(item: InboxItem): string | null {
  return item.extracted_data?.supplier?.name ?? null
}

function pickInvoiceDate(item: InboxItem): string | null {
  return item.extracted_data?.invoice?.invoiceDate ?? null
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
    (data.lineItems?.length ?? 0) > 0 || (data.vatBreakdown?.length ?? 0) > 0 ||
    // Same meaningful-amount predicate as the Belopp row render filter: a
    // zero-only prominentAmounts list must not count as "found something"
    // and suppress the retry / upgrade affordances.
    (data.prominentAmounts ?? []).some((a) => Number.isFinite(a.amount) && a.amount !== 0)
  )
}

/**
 * The fields the extraction is scored against, in the order a person reads
 * them. A subset of what hasAnyExtractedField checks (that test also counts
 * lineItems, vatBreakdown and prominentAmounts), so the "fält ifyllda" counter
 * never claims a field the "is anything here at all" test does not count: the
 * reverse can differ, e.g. a bankintyg with only prominentAmounts has fields
 * but counts 0 here.
 */
const EXTRACTED_FIELD_ACCESSORS: ((d: InvoiceExtractionResult) => unknown)[] = [
  (d) => d.supplier?.name,
  (d) => d.supplier?.orgNumber,
  (d) => d.supplier?.vatNumber,
  (d) => d.supplier?.bankgiro,
  (d) => d.supplier?.plusgiro,
  (d) => d.invoice?.invoiceNumber,
  (d) => d.invoice?.invoiceDate,
  (d) => d.invoice?.dueDate,
  (d) => d.invoice?.paymentReference,
  (d) => d.totals?.subtotal,
  (d) => d.totals?.vatAmount,
  (d) => d.totals?.total,
]

/** How many of them the extraction actually filled in. */
function countExtractedFields(data: InvoiceExtractionResult | null): number {
  if (!data) return 0
  return EXTRACTED_FIELD_ACCESSORS.reduce(
    (n, get) => n + (get(data) != null && get(data) !== '' ? 1 : 0),
    0,
  )
}

// Lifecycle stage of an inbox item. Single source of truth shared by the list
// filter, the count pills, and the row icons so they never drift apart.
//
// Precedence mirrors the FieldsRail: a booked item (supplier invoice, a
// direct journal entry, OR a matched transaction that is itself booked) is
// done and drops out of the active inbox. A matched-but-unbooked item is
// "linked": it STAYS in the inbox as its own category because the bank
// payment still needs booking (a document attached to a transaction is not
// the same as a booked one). An extraction failure is "error"; everything
// else needs a first action.
type InboxStatus = 'needs_action' | 'processing' | 'linked' | 'booked' | 'error'

// A matched transaction that is booked while this item's own underlag is not
// on its verifikat: not "booked" for the inbox, and not bookable either (the
// book routes 409 on an already-booked transaction). The rail explains it
// instead of offering a bridge that can only fail.
function isUnderlagDivergent(item: InboxItem): boolean {
  return (
    !!item.matched_transaction_journal_entry_id &&
    !!item.underlag_status &&
    item.underlag_status !== 'anchored'
  )
}

// One explanatory line per non-anchored status (#1548). 'unlinked' is the
// only one the daily reconcile can heal on its own; the others say what
// stands in the way instead of promising an automatic link.
const UNDERLAG_STATUS_MESSAGE_KEY: Record<Exclude<UnderlagStatus, 'anchored'>, string> = {
  unlinked: 'underlag_unlinked',
  unlinked_locked: 'underlag_unlinked_locked',
  anchored_elsewhere: 'underlag_anchored_elsewhere',
  unknown: 'underlag_unknown',
}

function deriveInboxStatus(item: InboxItem): InboxStatus {
  if (item.created_supplier_invoice_id || item.created_journal_entry_id) return 'booked'
  if (item.matched_transaction_journal_entry_id && !isUnderlagDivergent(item)) return 'booked'
  // Staged upload mid-extraction. Outranks 'linked': a transaction-anchored
  // upload is matched from birth, but offering the booking bridge before the
  // fields exist would book from empty data. Transient (seconds): stays in
  // "Att göra" via the todo bucket rather than earning its own pill.
  if (item.status === 'processing') return 'processing'
  if (item.matched_transaction_id) return 'linked'
  if (item.status === 'error') return 'error'
  return 'needs_action'
}

// ── Skeleton ─────────────────────────────────────────────────
// Shared with app/(dashboard)/e/[sector]/[slug]/loading.tsx so the route
// fallback and this client-fetch shell are one silhouette with no reflow.

const WorkspaceSkeleton = InvoiceInboxSkeleton

// ── Main component ───────────────────────────────────────────

export default function InvoiceInboxWorkspace(_props: WorkspaceComponentProps) {
  const { toast } = useToast()
  const router = useRouter()
  const t = useTranslations('inbox_workspace')
  const tStart = useTranslations('start_cards')
  const dismissKeyCompanyId = useCompanyOptional()?.company?.id ?? null
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  // Its own input: sharing the header's would upload without the purchase.
  const purchaseFileInputRef = useRef<HTMLInputElement | null>(null)
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
  const [filter, setFilter] = useState<
    'todo' | 'linked' | 'booked' | 'error' | 'all' | 'missing' | 'portal'
  >('todo')
  // Document-type filter (#2129): leverantörsfakturor vs underlag, on top of
  // the status filter. Not persisted, same as the status filter.
  const [kindFilter, setKindFilter] = useState<InboxKindFilter>('all')
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
  // Monotonic tokens for the in-flight detail and document reads. The user
  // can click another row while one is running, but also re-request the SAME
  // item (action refreshes, the processing->received re-select effect), so an
  // id comparison is not enough: only the newest request of each kind may
  // paint its outcome (a detail snapshot, a URL, or an error) onto the pane.
  const detailRequestRef = useRef(0)
  const docRequestRef = useRef(0)
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
  // The company's bookkeeping method drives the CTA hierarchy; read from the
  // session-cached settings row (lib/reference-data), no request of its own.
  const { settings: companySettings } = useCompanySettings()
  const accountingMethod: AccountingMethod =
    companySettings?.accounting_method === 'cash' ? 'cash' : 'accrual'

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
  // (SSR-safe: no window access during initial render). Scoped per company:
  // dismissing the card on one company must not hide it on the user's other
  // companies. The legacy unscoped key is honored as "dismissed everywhere"
  // so users who dismissed before the scoping do not get the card back.
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      const legacy = window.localStorage.getItem('gnubok.inbox.onboarding.dismissed') === '1'
      const scoped = dismissKeyCompanyId
        ? window.localStorage.getItem(`gnubok.inbox.onboarding.dismissed:${dismissKeyCompanyId}`) === '1'
        : false
      setOnboardingDismissed(legacy || scoped)
    } catch {
      // private browsing: keep default (show card)
    }
  }, [dismissKeyCompanyId])

  const handleDismissOnboarding = useCallback(() => {
    try {
      window.localStorage.setItem(
        dismissKeyCompanyId
          ? `gnubok.inbox.onboarding.dismissed:${dismissKeyCompanyId}`
          : 'gnubok.inbox.onboarding.dismissed',
        '1',
      )
    } catch {
      // ignore; in-memory state is enough for this session
    }
    setOnboardingDismissed(true)
  }, [dismissKeyCompanyId])

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

  // Where underlag come from. Three routes in, and the page should say so:
  // the mailboxes we search, WhatsApp for photographed receipts, and the
  // forwarding address that works with nothing connected at all.
  const [mailConnections, setMailConnections] = useState<InboxMailConnection[]>([])
  const [whatsapp, setWhatsapp] = useState<{ linked: boolean; phoneMasked?: string; verifiedAt?: string | null } | null>(null)
  const [sourcesOpen, setSourcesOpen] = useState(false)
  // Received-mail history (#2181): read when its panel is first opened, so
  // the sources strip costs nothing for people who never look.
  const [inboundMails, setInboundMails] = useState<InboundMail[] | null>(null)
  const [inboundMailsFailed, setInboundMailsFailed] = useState(false)
  // The route caps the list; when the window held more, say so rather than
  // let "every mail" stand over a list that is missing the oldest ones.
  const [inboundMailsTruncated, setInboundMailsTruncated] = useState(false)

  const fetchInboundMails = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/extensions/ext/invoice-inbox/inbound-history?days=${INBOUND_MAIL_DAYS}`,
      )
      if (!res.ok) throw new Error(`inbound-history ${res.status}`)
      const { data } = await res.json()
      setInboundMails(Array.isArray(data?.mails) ? data.mails : [])
      setInboundMailsTruncated(data?.has_more === true)
      setInboundMailsFailed(false)
    } catch (err) {
      console.error('[invoice-inbox] fetchInboundMails failed:', err)
      setInboundMailsFailed(true)
    }
  }, [])

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/extensions/ext/mail/connections')
        if (!res.ok) return
        const json = (await res.json()) as { data?: { connections?: InboxMailConnection[] } }
        setMailConnections(json.data?.connections ?? [])
      } catch {
        // The extension may not be enabled at all; stay quiet.
      }
    })()
    void (async () => {
      try {
        const res = await fetch('/api/extensions/ext/whatsapp-inbox/link')
        if (!res.ok) return
        // The route answers in camelCase (phoneMasked / verifiedAt); reading
        // snake_case here silently rendered a linked number as "–".
        const json = (await res.json()) as {
          data?: { linked: boolean; phoneMasked?: string; verifiedAt?: string | null }
        }
        if (json.data) setWhatsapp(json.data)
      } catch {
        // Same: not every company has it.
      }
    })()
  }, [])

  // Counting rows would not answer whether anything is searchable: a revoked
  // or expired connection is still a row, and the hunt skips it, so the button
  // would promise a search that returns nothing every pass. A dead mailbox
  // looking healthy is the exact failure this feature exists to surface, so it
  // must not start by doing it in its own header.
  const mailConnected = useMemo(
    () => mailConnections.some((c) => c.status === 'active'),
    [mailConnections],
  )
  const ailingMailbox = useMemo(
    () => mailConnections.find((c) => c.status !== 'active') ?? null,
    [mailConnections],
  )
  const sourceCount = mailConnections.length + (whatsapp?.linked ? 1 : 0) + (inboxAddress ? 1 : 0)

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

  // A pass can attach a document to a purchase, which moves a row from one
  // list to the other, so both refresh as the run goes rather than at the end.
  const {
    hunt,
    stop: stopHunt,
    hunting,
    progress: huntProgress,
    result: huntResult,
    setResult: setHuntResult,
  } = useReceiptHunt(() => {
    void fetchItems()
    void fetchPurchases()
  })

  // A run that found nothing leaves nothing to act on, so the line has no
  // reason to outlive the glance that reads it. A run that found something,
  // or failed, stays: both name a next step (press again, or a mailbox to
  // check) and both are worth still being on screen a minute later.
  useEffect(() => {
    if (hunting || !huntResult) return
    if (huntResult.failed || huntResult.fetched > 0) return
    const timer = setTimeout(() => setHuntResult(null), 6000)
    return () => clearTimeout(timer)
  }, [hunting, huntResult, setHuntResult])


  const selectedPurchase = useMemo(
    () => purchases.find((p) => p.id === selectedPurchaseId) ?? null,
    [purchases, selectedPurchaseId],
  )

  const portalPurchases = useMemo(() => purchases.filter((p) => p.portal), [purchases])
  const otherPurchases = useMemo(() => purchases.filter((p) => !p.portal), [purchases])

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
    // Two lists, because they are two different jobs. A purchase whose
    // supplier keeps invoices behind a login is one you can settle now by
    // going there; one with nothing known needs somebody to be asked. Mixing
    // them buries the twelve you can act on among the hundred you cannot.
    if (portalPurchases.length > 0 || filter === 'portal') {
      list.push({ key: 'portal', label: t('filter_portal'), count: portalPurchases.length })
    }
    if (otherPurchases.length > 0 || filter === 'missing') {
      list.push({ key: 'missing', label: t('filter_missing'), count: otherPurchases.length })
    }
    if (statusCounts.error > 0 || filter === 'error') {
      list.push({ key: 'error', label: 'Fel', count: statusCounts.error })
    }
    list.push({ key: 'all', label: 'Alla', count: statusCounts.all })
    return list
  }, [statusCounts, filter, portalPurchases.length, otherPurchases.length])

  const activePill = useMemo(() => pills.find((p) => p.key === filter), [pills, filter])

  const filteredPurchases = useMemo(() => {
    const base = filter === 'portal' ? portalPurchases : otherPurchases
    const term = searchTerm.trim().toLowerCase()
    if (term === '') return base
    return base.filter((p) =>
      [p.merchant_name, p.description].some((v) => v?.toLowerCase().includes(term)),
    )
  }, [portalPurchases, otherPurchases, filter, searchTerm])

  const statusFilteredItems = useMemo(() => {
    if (filter === 'missing' || filter === 'portal') return []
    return items.filter((item) => {
      // Status filter. "todo" is the active inbox: everything except booked.
      const status = deriveInboxStatus(item)
      if (filter === 'todo' && status === 'booked') return false
      if (filter === 'linked' && status !== 'linked') return false
      if (filter === 'booked' && status !== 'booked') return false
      if (filter === 'error' && status !== 'error') return false
      // 'all' → no status narrowing
      return true
    })
  }, [items, filter])

  // Per-kind counts for the type menu, over the status-filtered list so the
  // numbers match what picking an entry would show.
  const kindCounts = useMemo(() => {
    const counts: Record<InboxKindFilter, number> = {
      all: statusFilteredItems.length,
      supplier_invoice: 0,
      underlag: 0,
    }
    for (const item of statusFilteredItems) {
      const kind = resolveInboxKind(item)
      if (matchesInboxKindFilter(kind, 'supplier_invoice')) counts.supplier_invoice += 1
      else if (matchesInboxKindFilter(kind, 'underlag')) counts.underlag += 1
    }
    return counts
  }, [statusFilteredItems])

  // Rows the type menu is hiding right now (#2181): a +lev mail filed as a
  // leverantörsfaktura is invisible under Underlag, and the trigger's count
  // alone does not say that anything is missing.
  const hiddenByKindFilter = kindFilter === 'all' ? 0 : kindCounts.all - kindCounts[kindFilter]

  // The type menu only earns its row once something is classified (or the
  // user has already narrowed): an inbox of unclassified rows has nothing to
  // split.
  const showKindFilter =
    filter !== 'missing' &&
    filter !== 'portal' &&
    (kindFilter !== 'all' || kindCounts.supplier_invoice > 0 || kindCounts.underlag > 0)

  const filteredItems = useMemo(() => {
    const term = searchTerm.trim().toLowerCase()
    return statusFilteredItems.filter((item) => {
      // Type filter: sender hint first, then the AI classification.
      if (!matchesInboxKindFilter(resolveInboxKind(item), kindFilter)) return false

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
  }, [statusFilteredItems, kindFilter, searchTerm])

  // ── Selection ──────────────────────────────────────────────

  // Resolve the signed URL for a row's underlag. Every exit sets docState, so
  // the preview pane always says which of the four situations it is in: no
  // document, still loading, ready, or "we could not load it". The pane must
  // never fall back to "Inget underlag bifogat" for a row that has a
  // document_id, which is what the old silent catch produced.
  const loadDocument = useCallback(async (documentId: string | null) => {
    const request = ++docRequestRef.current
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
      if (docRequestRef.current !== request) return
      if (!res.ok) {
        setDocState('error')
        return
      }
      const { data } = await res.json()
      if (docRequestRef.current !== request) return
      // Always preview via the same-origin inline proxy. Signed Storage URLs
      // are served as Content-Disposition: attachment, which Chrome blocks in
      // iframe/img with "Det här innehållet har blockerats".
      setDocUrl(`/api/documents/${documentId}/inline`)
      setDocMime(data?.mime_type ?? null)
      setDocState('ready')
    } catch {
      // Timeout, offline, or an unparseable body. The document itself is
      // untouched, so the retry in the preview pane is the whole recovery.
      if (docRequestRef.current !== request) return
      setDocState('error')
    }
  }, [])

  const handleSelect = useCallback(async (id: string) => {
    const request = ++detailRequestRef.current
    setSelectedId(id)
    setSelectedPurchaseId(null)
    // Intentionally no auto-scroll: in the vertical-stack layout (below xl)
    // scrolling the preview into view pushes the list off-screen, and the
    // user has no obvious way back to pick another item. The row-highlight
    // + the preview content update are enough feedback that the tap took.

    // Seed the detail pane synchronously from the list row already in hand
    // (fetchItems returns full rows: status, amounts, extracted fields), and
    // start the document load in parallel with the detail GET. Clearing
    // `selected` first made every row click flash the no-selection branch
    // (onboarding card / "Välj en post") for a full round trip, then run a
    // second serialized round trip before the PDF even started loading.
    const listRow = items.find((it) => it.id === id) ?? null
    if (listRow) {
      setSelected(listRow)
      void loadDocument(listRow.document_id)
    } else {
      // Invalidate any in-flight document read: the pane is being cleared,
      // and a late resolution must not paint a URL or error onto it.
      docRequestRef.current++
      setSelected(null)
      setDocUrl(null)
      setDocMime(null)
      setDocState('none')
    }

    try {
      const res = await fetch(`/api/extensions/ext/invoice-inbox/items/${id}`)
      if (!res.ok) throw await resolveFailure(res)
      const json = await res.json()
      const item = json.data as InboxItem
      // A newer selection owns the pane now: dropping this response keeps a
      // slower earlier fetch (same item or another) from overwriting the
      // newest request's detail snapshot.
      if (detailRequestRef.current !== request) return
      setSelected(item)
      if (!listRow) {
        await loadDocument(item.document_id)
      } else if (item.document_id !== listRow.document_id) {
        // The detail row knows a different underlag than the list row we
        // seeded from (e.g. processing finished between paint and click).
        void loadDocument(item.document_id)
      }
    } catch (err) {
      if (detailRequestRef.current !== request) return
      toast({
        title: 'Kunde inte ladda dokumentet',
        description: failureText(err),
        variant: 'destructive',
      })
    }
  }, [items, toast, loadDocument])

  // The detail pane renders from its own fetched snapshot (`selected`), so
  // the realtime refetch updates the list row but would leave a selected
  // staged upload stuck on the in-flight skeleton after the processing ->
  // received flip. Re-read the detail when the list shows the flip landed.
  useEffect(() => {
    if (!selected || selected.isPlaceholder || selected.status !== 'processing') return
    const listRow = items.find((it) => it.id === selected.id)
    if (listRow && listRow.status !== 'processing') {
      void handleSelect(selected.id)
    }
  }, [items, selected, handleSelect])

  // ── Upload ─────────────────────────────────────────────────

  // `autoSelect`: jump the detail pane to the new placeholder/row. Useful
  // for a one-off drop (user expects to see what just landed). Harmful in
  // a multi-file queue (selection yanks around as each file processes).
  const uploadFile = useCallback(async (
    original: File,
    options: { autoSelect: boolean } = { autoSelect: true },
  ) => {
    // A phone photo is routinely larger than the request body the platform
    // will carry, and it rejects the upload itself, before the route can say
    // anything useful about it. Shrink what can be shrunk; what cannot be (a
    // scanned PDF) goes straight to Storage through a signed URL instead of a
    // multipart body. Only the inbox's own ceiling refuses anything now, here,
    // where we can name the size instead of letting the transfer fail.
    const file = exceedsHostedUploadLimit(original.size)
      ? await shrinkImageForUpload(original)
      : original
    if (exceedsInboxUploadLimit(file.size)) {
      reportUploadFailure({
        status: 0,
        size: file.size,
        type: file.type || 'unknown',
        reason: 'over inbox ceiling, refused client-side',
      })
      toast({
        title: 'Uppladdning misslyckades',
        description: inboxTooLargeMessage(file.size),
        variant: 'destructive',
      })
      return undefined
    }
    const directToStorage = exceedsHostedUploadLimit(file.size)

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
      let res: Response
      if (directToStorage) {
        res = await uploadViaSignedUrl(file)
      } else {
        const fd = new FormData()
        fd.append('file', file)
        res = await fetch('/api/extensions/ext/invoice-inbox/upload', {
          method: 'POST',
          body: fd,
        })
      }
      if (!res.ok) throw await resolveFailure(res)
      const json = await res.json()
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
      return json.data?.inbox_item_id as string | undefined
    } catch (err) {
      setItems((prev) => prev.filter((it) => it.id !== tempId))
      if (options.autoSelect) {
        setSelectedId((prev) => (prev === tempId ? null : prev))
        setSelected((prev) => (prev?.id === tempId ? null : prev))
      }
      const reason = failureText(err)
      reportUploadFailure({
        status: err instanceof ResolvedFailure ? err.status : 0,
        size: file.size,
        type: file.type || 'unknown',
        reason,
      })
      toast({
        title: 'Uppladdning misslyckades',
        description: reason,
        variant: 'destructive',
      })
    } finally {
      setIsUploading(false)
    }
  }, [fetchItems, handleSelect, toast])

  // Sequential queue: running multiple extractions concurrently would
  // hammer pdfjs on slow boxes. Per-file placeholder rows + the queue
  // counter on the upload button surface progress.
  /**
   * Upload a file and make it the underlag for one specific purchase.
   *
   * The generic upload only carries the file, so a document dropped while a
   * purchase was selected landed in the inbox unmatched: the pane showed that
   * purchase's amount and date under the drop zone and then quietly did not
   * use either. Matching afterwards through the endpoint that already exists
   * keeps the promise the copy makes.
   */
  const uploadForPurchase = useCallback(async (files: File[], transactionId: string) => {
    const [file, ...rest] = files
    if (!file) return
    const itemId = await uploadFile(file, { autoSelect: false })
    // A receipt scanned as two images, or an invoice with its specification,
    // arrives as one drop. Taking the first and discarding the rest in silence
    // left the purchase looking resolved with half its paperwork gone. They
    // cannot all be the underlag for one purchase, so the extras are filed in
    // the inbox rather than dropped on the floor.
    for (const extra of rest) await uploadFile(extra, { autoSelect: false })
    if (!itemId) return
    try {
      const res = await fetch(
        `/api/extensions/ext/invoice-inbox/items/${itemId}/match-transaction`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ transaction_id: transactionId }),
        },
      )
      if (!res.ok) throw await resolveFailure(res)
      toast({
        title: 'Underlag kopplat',
        description: rest.length ? `${file.name}. ${rest.length} till lades i inkorgen.` : file.name,
      })
      setSelectedPurchaseId(null)
      await Promise.all([fetchItems(), fetchPurchases()])
    } catch (err) {
      // The document is safely filed either way; only the link failed, and
      // the user can still make it by hand from the inbox.
      toast({
        title: 'Uppladdat, men inte kopplat',
        description: err instanceof ResolvedFailure
          ? `${failureText(err)} Dokumentet ligger i inkorgen, koppla det till köpet därifrån.`
          : 'Dokumentet ligger i inkorgen. Koppla det till köpet därifrån.',
        variant: 'destructive',
      })
      await fetchItems()
    }
  }, [uploadFile, toast, fetchItems, fetchPurchases])

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
    if (files.length === 0) return
    // Dropping while a purchase is selected means "this is that purchase's
    // receipt", wherever on the page it landed. Ignoring the selection would
    // file it loose and leave the user to match by hand what they had already
    // told us.
    if (selectedPurchaseId) {
      await uploadForPurchase(files, selectedPurchaseId)
      return
    }
    await uploadFiles(files)
  }, [uploadFiles, uploadForPurchase, selectedPurchaseId])

  // ── Delete ─────────────────────────────────────────────────

  const handleDelete = useCallback(async (id: string) => {
    if (!confirm('Ta bort dokumentet ur inkorgen?')) return
    setIsDeleting(true)
    try {
      const res = await fetch(`/api/extensions/ext/invoice-inbox/items/${id}`, {
        method: 'DELETE',
      })
      if (!res.ok) throw await resolveFailure(res)
      toast({ title: 'Borttagen' })
      if (selectedId === id) {
        setSelectedId(null)
        setSelected(null)
      }
      await fetchItems()
    } catch (err) {
      toast({
        title: 'Kunde inte ta bort',
        description: failureText(err),
        variant: 'destructive',
      })
    } finally {
      setIsDeleting(false)
    }
  }, [fetchItems, selectedId, toast])

  // Ranges walk the rendered inbox rows in order. Optimistic upload
  // placeholders render no checkbox, so they stay out of the range: their
  // temp-* ids are not server rows and must never reach a bulk action.
  const range = useRangeSelect({
    visibleIds: filteredItems.filter((item) => !item.isPlaceholder).map((item) => item.id),
    selectedIds,
    setSelectedIds,
  })
  const toggleSelected = useCallback(
    (id: string, extend?: boolean) => range.toggle(id, extend),
    [range],
  )

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set())
    range.resetAnchor()
  }, [range])

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
        (it) =>
          it.matched_transaction_id &&
          !it.created_journal_entry_id &&
          !it.created_supplier_invoice_id &&
          // A matched transaction that is already booked has nothing left to
          // bulk-book: the server would only skip it with a 409.
          !it.matched_transaction_journal_entry_id,
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
      if (!res.ok) throw await resolveFailure(res)
      const json = await res.json()
      setInboxAddress(json.data)
      setAddressLoadFailed(false)
      toast({ title: 'Ny adress skapad', description: json.data.address })
    } catch (err) {
      toast({
        title: 'Rotation misslyckades',
        description: failureText(err),
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
          <h1 className="text-sm shrink-0">Dokumentinkorg</h1>
          {/* Where the page's contents come from, behind one chip. The detail
              (which mailbox, when it was last read) is a thing people look up
              when something seems wrong, not something they read every visit.
              A mailbox that has stopped working is the exception, so that
              surfaces on the chip itself. */}
          {sourceCount > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSourcesOpen((v) => !v)}
              className={cn(
                'h-7 px-2 text-xs font-normal shrink-0',
                ailingMailbox ? 'text-warning' : 'text-muted-foreground',
              )}
              aria-expanded={sourcesOpen}
            >
              {/* No marker on the healthy state. Convention 5: a normal state
                  is muted text, and a chip every company sees always is a chip
                  that says nothing. Convention 12 rules out the sage anyway,
                  semantic colour being data rather than chrome. What remains is
                  the exception, which is the one thing worth an ochre word. */}
              {ailingMailbox && <AlertTriangle className="h-3 w-3 mr-1.5" />}
              {ailingMailbox
                ? `${ailingMailbox.emailAddress} behöver återanslutas`
                : `${sourceCount} ${sourceCount === 1 ? 'källa' : 'källor'}`}
              <ChevronDown className="h-3 w-3 ml-1 opacity-60" />
            </Button>
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
          {/* No image/heic or image/heif here on purpose: when HEIC is absent
              from accept, iOS Safari transcodes photo-library picks to JPEG,
              which AI extraction can read. The server allowlist still accepts
              HEIC for drag-drop and the email/WhatsApp channels. */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="application/pdf,image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={handleFileInputChange}
          />
          {/* The hunt lived only in Settings, so the button that fills this
              page sat on a different page. It runs in passes and reports as it
              goes, because a backlog does not clear in one request. */}
          {mailConnected && (
            <Button variant="ghost" size="sm" onClick={hunting ? stopHunt : hunt} disabled={false}>
              {hunting ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  {t('hunt_stop')}
                </>
              ) : (
                <>
                  <Search className="h-3.5 w-3.5 mr-1.5" />
                  Leta i mejlen
                </>
              )}
            </Button>
          )}
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

      {/* A pass takes over two minutes and reports nothing until it lands, so
          a spinner alone leaves somebody watching a button. This says which
          mailboxes are being read, what has been found so far, and keeps
          moving while the pass is silent. The bar is deliberately
          indeterminate: there is no honest percentage inside a pass, and a
          fake one is worse than none. */}
      {hunting && (
        <div className="border-b bg-secondary/30">
          <div className="h-0.5 overflow-hidden bg-border/40">
            <div className="hunt-sweep h-full w-1/3 bg-foreground/40" />
          </div>
          <div className="px-4 py-2.5 flex items-center gap-3 flex-wrap text-xs">
            <span className="flex items-center gap-2 min-w-0">
              <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0 text-muted-foreground" />
              <span className="truncate">
                {t('hunt_reading', {
                  mailboxes: mailConnections
                    .filter((c) => c.status === 'active')
                    .map((c) => c.emailAddress)
                    .join(', '),
                })}
              </span>
            </span>
            <span className="flex-1" />
            {huntProgress && (
              <span className="text-muted-foreground tabular-nums">
                {t('hunt_progress', {
                  pass: huntProgress.passes,
                  found: huntProgress.fetched,
                })}
              </span>
            )}
            <button type="button" onClick={stopHunt} className={QUIET_LINK_CLASS}>
              {t('hunt_stop')}
            </button>
          </div>
        </div>
      )}

      {!hunting && huntResult && (
        <div className="border-b px-4 py-2 text-xs flex items-center gap-2">
          {huntResult.failed ? (
            <span className="text-warning">
              {/* searchFailures counts mailboxes that refused; without it the
                  failure was ours, and telling somebody to go check a healthy
                  Gmail sends them after the wrong thing. */}
              {(huntResult.searchFailures ?? 0) > 0
                ? 'En brevlåda svarade inte. Försök igen om en stund.'
                : 'Sökningen kunde inte slutföras. Försök igen.'}
            </span>
          ) : huntResult.fetched > 0 ? (
            <span>
              <b className="font-medium tabular-nums">{huntResult.fetched}</b> nya underlag hämtade.{' '}
              {huntResult.remaining > 0 && (
                <>
                  <b className="font-medium tabular-nums">{huntResult.remaining}</b> köp kvar att söka
                  för: tryck igen.{' '}
                </>
              )}
              {/* "proposed" counts pending_operations rows, not links. The hunt
                  stages attach_document_to_transaction for a human to approve
                  and books nothing, so calling them kopplade would send the
                  user away believing purchases were done. */}
              {huntResult.proposed > 0 ? (
                <>
                  <b className="font-medium tabular-nums">{huntResult.proposed}</b> förslag väntar på{' '}
                  <Link href="/pending" className="underline hover:text-foreground">
                    granskning
                  </Link>
                  .
                </>
              ) : (
                // A press fetches a bounded number of receipts, so an empty
                // result usually means "not yet", not "nothing there". Saying
                // only the first sends people away from a mailbox that still
                // has their receipts in it.
                <>Inget matchade något köp än. Tryck igen för att leta vidare.</>
              )}
            </span>
          ) : (
            <span className="text-muted-foreground">
              Inga nya underlag i brevlådorna för de köp som saknar ett.
            </span>
          )}
        </div>
      )}

      {/* Opened from the chip. Three ways in, each with the one fact that
          matters about it: an address you can forward to, mailboxes we search,
          and the number receipts arrive from. Nothing here is configuration;
          that still lives in Inställningar. */}
      {sourcesOpen && (
        <div className="border-b bg-muted/20 text-xs">
          {inboxAddress && (
            <div className="flex items-center gap-3 px-4 py-2 border-b border-border">
              <Mail className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <div className="min-w-0 flex-1">
                <span className="tabular-nums">{inboxAddress.address}</span>
                {/* Plus-addressing (#2129): the sender sorts the mail by
                    writing +lev or +ver before the @. Both variants spelled
                    out, since a tag is easier to copy than to construct. */}
                <p className="mt-1 text-muted-foreground break-all">
                  {t('address_plus_hint', {
                    lev: plusAddress(inboxAddress.address, 'lev'),
                    ver: plusAddress(inboxAddress.address, 'ver'),
                  })}
                </p>
              </div>
              <InboxAddressBar
                address={inboxAddress.address}
                onRotate={handleRotateAddress}
                isRotating={isRotating}
              />
            </div>
          )}

          {/* Every mail that reached the address (#2181), whatever became of
              it: filed, duplicate, rejected, failed. This is where "I mailed
              it and it is not there" gets an answer instead of a shrug. */}
          {inboxAddress && (
            <details
              className="group border-b border-border"
              onToggle={(e) => {
                if (e.currentTarget.open && inboundMails === null && !inboundMailsFailed) {
                  void fetchInboundMails()
                }
              }}
            >
              <summary className="flex items-center gap-3 px-4 py-2 cursor-pointer list-none hover:bg-secondary/40">
                <Inbox className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <span className="flex-1 truncate">{t('inbound_mail_title')}</span>
                {inboundMails !== null && (
                  <span className="tabular-nums text-muted-foreground shrink-0">{inboundMails.length}</span>
                )}
                <ChevronRight className="h-3 w-3 text-muted-foreground transition-transform group-open:rotate-90 shrink-0" />
              </summary>
              <div className="px-4 pb-2.5 pl-11 text-[11px] text-muted-foreground space-y-1.5">
                <p>
                  {inboundMailsTruncated && inboundMails
                    ? t('inbound_mail_truncated', { count: inboundMails.length, days: INBOUND_MAIL_DAYS })
                    : t('inbound_mail_hint', { days: INBOUND_MAIL_DAYS })}
                </p>
                {inboundMailsFailed ? (
                  <AttnLine
                    action={{ label: t('retry'), onClick: () => { void fetchInboundMails() } }}
                  >
                    {t('inbound_mail_load_failed')}
                  </AttnLine>
                ) : inboundMails === null ? (
                  <span className="flex items-center gap-1.5">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    {t('inbound_mail_loading')}
                  </span>
                ) : inboundMails.length === 0 ? (
                  <p>{t('inbound_mail_empty', { days: INBOUND_MAIL_DAYS })}</p>
                ) : (
                  <ul className="space-y-1.5">
                    {inboundMails.map((mail) => (
                      <InboundMailRow
                        key={mail.event_id}
                        mail={mail}
                        domain={inboxAddress.address.split('@')[1] ?? ''}
                        onOpenItem={handleSelect}
                      />
                    ))}
                  </ul>
                )}
              </div>
            </details>
          )}

          {mailConnections.map((c) => (
            <details key={c.id} className="group border-b border-border">
              <summary className="flex items-center gap-3 px-4 py-2 cursor-pointer list-none hover:bg-secondary/40">
                {c.provider === 'gmail' ? (
                  <GoogleMark className="h-3.5 w-3.5 shrink-0" />
                ) : (
                  <MicrosoftMark className="h-3.5 w-3.5 shrink-0" />
                )}
                <span className="truncate flex-1">{c.emailAddress}</span>
                {c.status !== 'active' && (
                  <Badge variant="warning" className="text-[10px] font-normal shrink-0">
                    Behöver återanslutas
                  </Badge>
                )}
                <ChevronRight className="h-3 w-3 text-muted-foreground transition-transform group-open:rotate-90 shrink-0" />
              </summary>
              {/* One level down, because this is what you look up when a
                  mailbox seems to have gone quiet, not what you read on the
                  way past. */}
              <dl className="px-4 pb-2.5 pl-11 text-[11px] text-muted-foreground space-y-0.5">
                <div className="flex gap-2">
                  <dt className="w-24 shrink-0">{t('source_last_searched')}</dt>
                  <dd className="tabular-nums">
                    {c.lastSearchedAt ? formatDateLong(c.lastSearchedAt) : t('source_never_searched')}
                  </dd>
                </div>
                <div className="flex gap-2">
                  <dt className="w-24 shrink-0">Status</dt>
                  <dd>
                    {c.status === 'active'
                      ? t('source_searched_when_hunting')
                      : t('source_not_searched')}
                  </dd>
                </div>
              </dl>
            </details>
          ))}

          {whatsapp?.linked && (
            <details className="group border-b border-border">
              <summary className="flex items-center gap-3 px-4 py-2 cursor-pointer list-none hover:bg-secondary/40">
                <WhatsAppMark className="h-3.5 w-3.5 shrink-0" />
                <span className="flex-1 truncate">WhatsApp</span>
                <ChevronRight className="h-3 w-3 text-muted-foreground transition-transform group-open:rotate-90 shrink-0" />
              </summary>
              <dl className="px-4 pb-2.5 pl-11 text-[11px] text-muted-foreground space-y-0.5">
                <div className="flex gap-2">
                  <dt className="w-24 shrink-0">{t('source_whatsapp_number')}</dt>
                  <dd className="tabular-nums">{whatsapp.phoneMasked ?? '-'}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="w-24 shrink-0">Status</dt>
                  <dd>{whatsapp.verifiedAt ? t('source_verified') : t('source_unverified')}</dd>
                </div>
              </dl>
            </details>
          )}

        </div>
      )}


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
              {/* One row instead of three. Five filters wrapped to three lines
                  in a 280px column, and the counts are what people actually
                  read, so they stay visible on the trigger and inside the menu
                  rather than being traded away for the space. */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full justify-between h-8 px-2.5 text-xs font-normal"
                  >
                    <span className="flex items-center gap-1.5 min-w-0">
                      <span className="truncate">{activePill?.label ?? 'Att göra'}</span>
                      <span className="tabular-nums text-muted-foreground">
                        {activePill?.count ?? 0}
                      </span>
                    </span>
                    <ChevronDown className="h-3.5 w-3.5 opacity-60 shrink-0" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-[--radix-dropdown-menu-trigger-width]">
                  {pills.map((pill) => (
                    <DropdownMenuItem
                      key={pill.key}
                      onSelect={() => {
                        setFilter(pill.key)
                        // The panes show one kind of row at a time; a stale
                        // selection from the other kind would outlive its list.
                        if (pill.key === 'missing' || pill.key === 'portal') setSelectedId(null)
                        else setSelectedPurchaseId(null)
                      }}
                      className="justify-between text-xs"
                    >
                      <span className="flex items-center gap-2">
                        <Check
                          className={cn(
                            'h-3.5 w-3.5',
                            filter === pill.key ? 'opacity-100' : 'opacity-0',
                          )}
                        />
                        {pill.label}
                      </span>
                      <span className="tabular-nums text-muted-foreground">{pill.count}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              {/* Document type (#2129): the Fortnox-style split between
                  leverantörsfakturor and bokföringsunderlag, as a second
                  menu in the same shape as the status one. */}
              {showKindFilter && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full justify-between h-8 px-2.5 text-xs font-normal"
                    >
                      <span className="flex items-center gap-1.5 min-w-0">
                        <span className="truncate">{t(`kind_filter_${kindFilter}`)}</span>
                        <span className="tabular-nums text-muted-foreground">
                          {kindCounts[kindFilter]}
                        </span>
                      </span>
                      <ChevronDown className="h-3.5 w-3.5 opacity-60 shrink-0" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-[--radix-dropdown-menu-trigger-width]">
                    {INBOX_KIND_FILTERS.map((key) => (
                      <DropdownMenuItem
                        key={key}
                        onSelect={() => setKindFilter(key)}
                        className="justify-between text-xs"
                      >
                        <span className="flex items-center gap-2">
                          <Check
                            className={cn(
                              'h-3.5 w-3.5',
                              kindFilter === key ? 'opacity-100' : 'opacity-0',
                            )}
                          />
                          {t(`kind_filter_${key}`)}
                        </span>
                        <span className="tabular-nums text-muted-foreground">{kindCounts[key]}</span>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
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
                <div className="xl:hidden p-3">
                  <StartCard
                    card="geese"
                    layout="bleed-left"
                    dense
                    title={tStart('inbox_title')}
                    body={tStart('inbox_body')}
                    primary={{ label: tStart('inbox_primary'), href: '/settings/mail' }}
                    secondary={{
                      label: tStart('inbox_secondary'),
                      onClick: () => fileInputRef.current?.click(),
                    }}
                    onDismiss={handleDismissOnboarding}
                    dismissLabel={tStart('inbox_dismiss')}
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
          ) : (filter === 'missing' || filter === 'portal' ? filteredPurchases.length : filteredItems.length) === 0 ? (
            <div className="p-6 text-center text-xs text-muted-foreground">
              {/* A leftover search term makes every one of these false: the
                  trigger above still shows the unsearched count, so the page
                  would claim every purchase has its underlag while the button
                  beside it reads 50. */}
              {searchTerm.trim() !== ''
                ? `Inga träffar på ”${searchTerm.trim()}”.`
                : kindFilter !== 'all' && filter !== 'missing' && filter !== 'portal'
                  // Same trap as the search term: "allt är bearbetat" would be
                  // false while the status trigger above still counts rows the
                  // type menu is hiding. Purchase lists ignore the type menu,
                  // so a leftover kind filter must not speak for them.
                  ? t('empty_no_kind_hits')
                  : filter === 'todo'
                    ? 'Inget att åtgärda; allt är bearbetat.'
                    : filter === 'portal'
                      ? 'Inga köp väntar på en faktura från en portal.'
                      : filter === 'missing'
                        ? 'Varje köp har sitt underlag.'
                        : 'Inga poster matchar filtret.'}
            </div>
          ) : (
            <ul>
              {filter === 'missing' || filter === 'portal'
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
                      onToggleChecked={(extend) => toggleSelected(item.id, extend)}
                      anyChecked={selectedIds.size > 0}
                    />
                  ))}
            </ul>
          )}
          {/* The type menu hides rows without saying so (#2181): a +lev mail
              is a leverantörsfaktura and does not show under Underlag. Say
              how many, with the one click that brings them back. The empty
              state above already says it when nothing is left. */}
          {filter !== 'missing' && filter !== 'portal' && filteredItems.length > 0 && hiddenByKindFilter > 0 && (
            <div className="px-4 py-2 border-t text-[11px] text-muted-foreground">
              {t('hidden_by_kind_filter', { count: hiddenByKindFilter })}{' '}
              <button
                type="button"
                className={cn(QUIET_LINK_CLASS, 'underline')}
                onClick={() => setKindFilter('all')}
              >
                {t('kind_filter_all')}
              </button>
            </div>
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
            // There is no file to show, so the pane says why and then offers
            // the one thing that resolves it. Telling somebody a document is
            // missing without a place to put it is half an answer.
            <div className="h-full flex items-center justify-center p-8">
              <div className="text-center max-w-sm w-full">
                <FileQuestion className="h-6 w-6 mx-auto mb-3 text-muted-foreground opacity-60" />
                <p className="text-sm">{t('purchase_no_document')}</p>
                <p className="text-xs text-muted-foreground mt-1.5">
                  {selectedPurchase.portal
                    ? `${selectedPurchase.portal.vendor} skickar ingen fil. Hämta fakturan och släpp den här.`
                    : 'Vi har sökt i brevlådorna. Släpp kvittot här, eller vidarebefordra det till inkorgsadressen.'}
                </p>

                {selectedPurchase.portal && (
                  <Button size="sm" variant="outline" className="mt-4" asChild>
                    <a href={selectedPurchase.portal.url} target="_blank" rel="noopener noreferrer">
                      Öppna {selectedPurchase.portal.vendor}
                      <ExternalLink className="h-3.5 w-3.5 ml-1.5" />
                    </a>
                  </Button>
                )}

                {/* Same accept list as the header input: HEIC left out so iOS
                    delivers JPEG from the photo library. */}
                <input
                  ref={purchaseFileInputRef}
                  type="file"
                  className="hidden"
                  accept="application/pdf,image/jpeg,image/png,image/webp"
                  onChange={async (e) => {
                    const files = Array.from(e.target.files ?? [])
                    if (files.length > 0) await uploadForPurchase(files, selectedPurchase.id)
                    if (purchaseFileInputRef.current) purchaseFileInputRef.current.value = ''
                  }}
                />
                <button
                  type="button"
                  onClick={() => purchaseFileInputRef.current?.click()}
                  disabled={isUploading}
                  className={cn(
                    'mt-4 w-full rounded-lg border border-dashed px-4 py-6 text-xs transition-colors',
                    'text-muted-foreground hover:border-foreground hover:text-foreground',
                    isDragging && 'border-foreground text-foreground bg-secondary/40',
                  )}
                >
                  {isUploading ? (
                    <span className="flex items-center justify-center gap-2">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      Laddar upp…
                    </span>
                  ) : (
                    <>
                      Släpp filen här, eller klicka för att välja
                      <span className="block mt-1 opacity-70">
                        {formatCurrency(Math.abs(selectedPurchase.amount), selectedPurchase.currency ?? undefined)}
                        {' · '}
                        {formatDate(selectedPurchase.date)}
                      </span>
                    </>
                  )}
                </button>
              </div>
            </div>
          ) : selected ? (
            <DocumentPreview
              docUrl={docUrl}
              docMime={docMime}
              isProcessing={!!selected.isPlaceholder}
              loadState={docState}
              onRetry={() => { void loadDocument(selected.document_id) }}
            />
          ) : showOnboarding ? (
            <div className="h-full flex flex-col justify-center px-4 py-6">
              <div className="animate-fade-in">
                <StartCard
                  card="geese"
                  layout="bleed-left"
                  dense
                  floatIcons
                  title={tStart('inbox_title')}
                  body={tStart('inbox_body')}
                  primary={{ label: tStart('inbox_primary'), href: '/settings/mail' }}
                  secondary={{
                    label: tStart('inbox_secondary'),
                    onClick: () => fileInputRef.current?.click(),
                  }}
                  onDismiss={handleDismissOnboarding}
                  dismissLabel={tStart('inbox_dismiss')}
                />
                <p className="mt-4 text-center text-xs text-muted-foreground">
                  {t('drop_anywhere_hint')}
                </p>
              </div>
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
            <div className="absolute inset-0 bg-primary/5 border-2 border-dashed border-primary rounded-lg m-4 flex items-center justify-center pointer-events-none">
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
              onRegisterExpense={() => router.push(`/expenses?new=1&inbox_item=${selected.id}`)}
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
              onBookedLocally={async () => {
                // Re-read the item so the rail sees created_journal_entry_id
                // and switches to the booked state; without it the same
                // underlag can be posted twice.
                await Promise.all([fetchItems(), fetchPurchases(), handleSelect(selected.id)])
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

function InboundMailRow({
  mail,
  domain,
  onOpenItem,
}: {
  mail: InboundMail
  /** The shared inbound domain, from the company's own address. */
  domain: string
  onOpenItem: (id: string) => void
}) {
  const t = useTranslations('inbox_workspace')
  // The address is reconstructed from the inbox row, never read from the
  // event: one line per tag the mail used, or the bare address.
  const tags = mail.tags ?? []
  const address = mail.custom_domain
    ? t('inbound_mail_custom_domain')
    : mail.inbox_local_part
      ? (tags.length > 0 ? tags : [null])
          .map((tag) => `${mail.inbox_local_part}${tag ? `+${tag}` : ''}@${domain}`)
          .join(', ')
      : t('inbound_mail_former_address')
  const counts = { filed: 0, duplicate: 0, rejected: 0, failed: 0 }
  for (const a of mail.attachments ?? []) {
    if (a.outcome in counts) counts[a.outcome] += 1
  }
  const parts: string[] = []
  if (mail.outcome === 'rate_limited') parts.push(t('inbound_outcome_rate_limited'))
  else if (mail.outcome === 'no_attachments') parts.push(t('inbound_outcome_empty'))
  else if (mail.outcome === 'email_body') parts.push(t('inbound_outcome_body'))
  else if (mail.outcome === 'email_body_duplicate') parts.push(t('inbound_outcome_body_duplicate'))
  else if (mail.outcome === 'fan_out_capped') parts.push(t('inbound_outcome_fan_out_capped'))
  else {
    if (counts.filed > 0) parts.push(t('inbound_outcome_filed', { count: counts.filed }))
    if (counts.duplicate > 0) parts.push(t('inbound_outcome_duplicate', { count: counts.duplicate }))
    if (counts.rejected > 0) parts.push(t('inbound_outcome_rejected', { count: counts.rejected }))
    if (counts.failed > 0) parts.push(t('inbound_outcome_failed', { count: counts.failed }))
  }
  const hasFailure =
    mail.outcome === 'rate_limited' || mail.outcome === 'fan_out_capped' || counts.rejected > 0 || counts.failed > 0
  // Every row the mail produced, in attachment order, each a click away.
  const openable: string[] = []
  if (mail.inbox_item_id) openable.push(mail.inbox_item_id)
  for (const a of mail.attachments ?? []) {
    if (a.inbox_item_id && !openable.includes(a.inbox_item_id)) openable.push(a.inbox_item_id)
  }
  return (
    <li className="space-y-0.5">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="tabular-nums shrink-0">{formatDateTime(mail.occurred_at)}</span>
        <span className="truncate text-foreground">{address}</span>
        {(mail.unknown_tag_count ?? 0) > 0 && (
          <span>{t('inbound_unknown_tags', { count: mail.unknown_tag_count })}</span>
        )}
      </div>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className={cn(hasFailure && 'text-destructive')}>{parts.join(', ')}</span>
        {openable.map((id, i) => (
          <button
            key={id}
            type="button"
            className={cn(QUIET_LINK_CLASS, 'underline')}
            onClick={() => onOpenItem(id)}
          >
            {openable.length === 1 ? t('inbound_open') : t('inbound_open_nth', { n: i + 1 })}
          </button>
        ))}
      </div>
      {mail.tag_conflict && <AttnLine>{t('inbound_tag_conflict')}</AttnLine>}
    </li>
  )
}

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
  onToggleChecked: (extend?: boolean) => void
  /** True when bulk-select mode is active anywhere in the list: keeps the
      checkbox visible (otherwise it's hover-only on desktop). */
  anyChecked: boolean
}) {
  const t = useTranslations('inbox_workspace')
  // Radix' onCheckedChange carries no mouse event: the preceding click records
  // whether shift was held, for range selection.
  const shiftHeld = useRef(false)
  const amount = pickAmount(item)
  const supplierName = pickSupplierName(item)
  const invoiceDate = pickInvoiceDate(item)
  const isPlaceholder = !!item.isPlaceholder
  const kind = resolveInboxKind(item)
  const status = deriveInboxStatus(item)
  const isErrored = status === 'error'
  const isBooked = status === 'booked'
  const isLinkedToTransaction = status === 'linked'
  // Staged upload: the row is real (that IS the "mottaget" ack) but the
  // deferred AI extraction is still in flight. The realtime refetch flips it.
  const isExtracting = status === 'processing'
  // A chat question the sender never answered (48h TTL hit): the missing
  // info should be completed here instead. Quiet hint, not a status: the
  // item still books normally. Booked items drop the reminder.
  const hasUnansweredQuestion =
    !isBooked && item.channel_context?.pending_question?.status === 'moved_to_app'

  const receivedMeta = (
    <span className="truncate">
      {timeAgo(item.email_received_at ?? item.created_at)}
      {invoiceDate && (
        <> · <span className="tabular-nums">{formatDate(invoiceDate)}</span></>
      )}
    </span>
  )

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
            'flex select-none items-center pl-2.5 pr-1.5 transition-opacity',
            // Solid on touch (pointer-coarse) or when any selection is active;
            // otherwise muted-but-visible at rest. focus-within because this
            // wraps the checkbox rather than being it.
            anyChecked
              ? 'opacity-100'
              : cn(CHECKBOX_REVEAL_CLASS, 'focus-within:opacity-100')
          )}
          onClick={(e) => e.stopPropagation()}
        >
          <Checkbox
            checked={isChecked}
            onClick={(e) => {
              shiftHeld.current = e.shiftKey
            }}
            onCheckedChange={() => onToggleChecked(shiftHeld.current)}
            aria-label="Markera post"
            className="h-3.5 w-3.5 border-foreground"
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
            <WhatsAppMark className="h-3 w-3 shrink-0" />
          ) : item.source === 'peppol' ? (
            // Received as a structured e-invoice over the Peppol network.
            <Globe className="h-3 w-3 text-muted-foreground shrink-0" aria-label="Peppol" />
          ) : item.channel_context?.mail_provider === 'gmail' ? (
            // The hunt records which mailbox it pulled a receipt from, so the
            // brand is known rather than guessed. Mail that arrived by
            // forwarding has no connection behind it and keeps the envelope.
            <GoogleMark className="h-3 w-3 shrink-0" />
          ) : item.channel_context?.mail_provider === 'microsoft' ? (
            <MicrosoftMark className="h-3 w-3 shrink-0" />
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
          ) : (
            <span className="flex items-center gap-1.5 min-w-0">
              {/* Document kind (#2129): sender's +lev / +ver hint first, then
                  the AI classification. Nothing when neither is known. */}
              {kind && (
                <Badge variant="outline" className="font-normal shrink-0">
                  {t(`doc_kind_${kind}`)}
                </Badge>
              )}
              {isExtracting ? (
                <Badge variant="outline" className="font-normal">
                  <Loader2 className="h-2.5 w-2.5 mr-1 animate-spin" />
                  {t('processing_chip')}
                </Badge>
              ) : (
                <>
                  {item.extraction_skipped && (
                    <Badge variant="outline" className="font-normal">Inte AI-tolkad</Badge>
                  )}
                  {hasUnansweredQuestion && (
                    <Badge variant="outline" className="font-normal text-attn border-attn/40">
                      {t('wa_question_badge')}
                    </Badge>
                  )}
                </>
              )}
              {receivedMeta}
            </span>
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
        <div className="max-h-full max-w-3xl bg-background rounded-lg border overflow-hidden flex">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={docUrl}
            alt="Underlag"
            className="block max-h-[calc(100vh-9rem)] max-w-full w-auto h-auto object-contain"
          />
        </div>
      ) : docMime === 'text/html' ? (
        // HTML mail underlag: arbitrary sender-controlled markup. sandbox
        // with no tokens = opaque origin, no scripts, no forms, no popups.
        // bg-white because mail HTML assumes a white canvas and would render
        // transparent (unreadable in dark mode) otherwise.
        <div className="h-full w-full max-w-3xl bg-background rounded-lg border overflow-hidden">
          <iframe
            src={docUrl}
            sandbox=""
            className="w-full h-full border-0 bg-white"
            title="Underlag"
          />
        </div>
      ) : (
        // PDF: iframe needs explicit height, frame fills the available pane.
        <div className="h-full w-full max-w-3xl bg-background rounded-lg border overflow-hidden">
          <embed src={docUrl} type="application/pdf" className="w-full h-full border-0" title="Underlag" />
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

interface InboxMailConnection {
  id: string
  provider: 'gmail' | 'microsoft'
  emailAddress: string
  status: 'active' | 'needs_reconsent' | 'revoked'
  lastSearchedAt: string | null
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
  const t = useTranslations('inbox_workspace')
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
            {purchase.merchant_name || purchase.description || t('purchase_unknown')}
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
            <Badge data-ph-mask="" variant="outline" className="text-[10px] font-normal">
              {purchase.portal.vendor}
            </Badge>
          )}
        </div>
      </button>
    </li>
  )
}

function PurchaseRail({ purchase }: { purchase: PurchaseWithoutUnderlag }) {
  const t = useTranslations('inbox_workspace')
  return (
    <div className="p-4 space-y-4">
      <div>
        <h3 className="text-sm">
          {purchase.merchant_name || purchase.description || t('purchase_unknown')}
        </h3>
        <p className="text-xs text-muted-foreground mt-0.5">{t('purchase_kind')}</p>
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
            <dt className="text-muted-foreground shrink-0">{t('purchase_bank_text')}</dt>
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
  /** Skeleton rows seeded from the matched bank transaction when `lines` is
      empty: the amount in SEK against the settlement account, cost side left
      blank. Editor prefill only; never rendered as a proposal. */
  fallback_lines?: { account_number: string; debit_amount: number; credit_amount: number; description: string }[]
  /** The matched bank row's SEK amount and date, present on empty proposals
      so the dialog can still show the kronor figure. */
  transaction?: { amount_sek: number; date: string } | null
}

const SUGGESTION_SOURCE_LABEL: Record<string, string> = {
  counterparty_template: 'Så du brukar bokföra den här leverantören',
  booking_template: 'Från en bokföringsmall',
  mapping_rule: 'Från en konteringsregel',
}

/** Why there is no proposal, said plainly rather than shown as an empty table. */
const SUGGESTION_EMPTY_REASON: Record<string, string> = {
  no_mapping: 'Okänd leverantör. Bokför en gång, så känns den igen.',
  currency_unsupported:
    'Köpet är i utländsk valuta och matchades av en konteringsregel. Momsen skulle bli fel, så vi visar inget förslag.',
}

function ProposedBooking({
  itemId,
  onLoaded,
}: {
  itemId: string
  /** Hands the loaded proposal up so the editor can open pre-filled with it. */
  onLoaded?: (data: SuggestedBooking | null) => void
}) {
  const t = useTranslations('inbox_workspace')
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
        onLoaded?.(json.data)
        setState('ready')
      })
      .catch(() => {
        // A suggestion that cannot be fetched is not something the user did:
        // stay quiet rather than showing an error beside their document.
        if (!cancelled) {
          onLoaded?.(null)
          setState('failed')
        }
      })
    return () => {
      cancelled = true
      controller.abort()
    }
    // onLoaded is intentionally excluded: a new identity each render
    // would refetch on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        <h3 className="text-xs">{t('proposal_title')}</h3>
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
          <summary className="cursor-pointer hover:text-foreground">{t('proposal_why')}</summary>
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
  onRegisterExpense,
  onMatchTransaction,
  onUnmatchTransaction,
  onAskAssistant,
  isDeleting,
  onFieldsUpdated,
  onRetryRequested,
  onBookedLocally,
}: {
  item: InboxItem
  docMime: string | null
  accountingMethod: AccountingMethod
  onDelete: () => void
  onBookDirect: () => void
  onCreateSupplierInvoice: () => void
  onRegisterExpense: () => void
  onMatchTransaction: () => void
  onUnmatchTransaction: () => Promise<void>
  onAskAssistant?: (transactionId: string) => void
  isDeleting: boolean
  onFieldsUpdated: (data: InvoiceExtractionResult) => void
  /** Re-read the item after this rail posted a verifikat for it. */
  onBookedLocally?: () => void
  onRetryRequested: () => Promise<void>
}) {
  const { toast } = useToast()
  const hasAi = useCapability(CAPABILITY.ai)
  const { appName } = useBranding()
  const data = item.extracted_data
  const resolvedKind = resolveInboxKind(item)
  const [proposal, setProposal] = useState<SuggestedBooking | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  // A proposal belongs to one item; carrying it to the next would offer the
  // previous underlag's accounts for this one's money.
  useEffect(() => {
    setProposal(null)
    setEditOpen(false)
  }, [item.id])

  const isProcessed = !!item.created_supplier_invoice_id
  const underlagDivergent = isUnderlagDivergent(item)
  // The verifikat this item resolved into: its own stamp, or the entry that
  // anchors its matched (and already booked) transaction, unless this item's
  // own underlag never reached it. See InboxItem.
  const bookedEntryId =
    item.created_journal_entry_id ??
    (underlagDivergent ? null : item.matched_transaction_journal_entry_id) ??
    null
  const isBookedDirectly = !isProcessed && !!bookedEntryId
  // "Resolved" now means a journal entry exists: matched_transaction_id alone
  // is not resolved, it's the prerequisite for booking against that tx.
  const isLinkedToTransaction = !isProcessed && !isBookedDirectly && !!item.matched_transaction_id
  // The booking bridge (proposal, book/ask actions) only while the
  // transaction is unbooked: a divergent item's transaction already has a
  // verifikat, so booking would 409. It gets an explanation and a link.
  const showBookingBridge = isLinkedToTransaction && !underlagDivergent
  const isResolved = isProcessed || isBookedDirectly
  // Staged upload mid-extraction: a real row whose deferred AI extraction has
  // not landed yet. Same disabled treatment as the optimistic placeholder
  // (skeleton fields, no actions); the realtime flip re-enables everything.
  const isExtracting = !item.isPlaceholder && item.status === 'processing'
  const inFlight = !!item.isPlaceholder || isExtracting
  const [isUnmatchingTx, setIsUnmatchingTx] = useState(false)
  const [isRetrying, setIsRetrying] = useState(false)
  // Larger edit surface for the extracted fields (the rail is deliberately
  // compact and users found it hard to read/fill: dialog reuses the same
  // autosaving list at a comfortable size). Closes on item switch so it never
  // shows fields for a row other than the selected one.
  const [fieldsExpanded, setFieldsExpanded] = useState(false)
  useEffect(() => {
    setFieldsExpanded(false)
  }, [item.id])
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
      if (!res.ok) {
        toast({
          title: 'Tolkning misslyckades',
          description: (await resolveFailure(res)).message,
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
          <h3 className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
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
      {(resolvedKind ||
        data?.payment?.method ||
        data?.pages ||
        (data?.totals?.total == null &&
          (data?.prominentAmounts ?? []).some((a) => Number.isFinite(a.amount) && a.amount !== 0))) && (
        <div className="border-b px-4 py-3 text-xs space-y-1">
          {/* Same resolution as the list row (sender's +lev / +ver hint first,
              then the AI), so the pane never contradicts the badge. */}
          {resolvedKind && (
            <div className="flex gap-2">
              <span className="text-muted-foreground w-14 shrink-0">{t('doc_kind_label')}</span>
              <span>{t(`doc_kind_${resolvedKind}`)}</span>
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
          {/* Amounts read off a multi-amount non-invoice document (an AGI
              besked listing lön/skatt/avgifter): no single figure is "the"
              total, so they show here as context while TOTALT stays empty for
              the user to settle. Single-amount documents don't render this:
              their amount is promoted into the editable TOTALT field
              (promoteSingleProminentAmount), which also hides this row via
              the totals.total == null condition. Zero amounts are noise
              ("Totalt månadspris: 0 kr"), same filter as matching applies. */}
          {data?.totals?.total == null &&
            (data?.prominentAmounts ?? []).some((a) => Number.isFinite(a.amount) && a.amount !== 0) && (
            <div className="flex gap-2">
              <span className="text-muted-foreground w-14 shrink-0">{t('prominent_amounts_label')}</span>
              <span className="tabular-nums">
                {(data?.prominentAmounts ?? [])
                  .filter((a) => Number.isFinite(a.amount) && a.amount !== 0)
                  .map((a) =>
                    a.label
                      ? `${a.label}: ${formatCurrency(a.amount, data?.invoice?.currency ?? 'SEK')}`
                      : formatCurrency(a.amount, data?.invoice?.currency ?? 'SEK'),
                  )
                  .join(' · ')}
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
          <h3 className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
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
          <span className="text-foreground font-medium">{extractedSupplierName}</span>
          {' finns inte upplagd än. Den skapas när du gör leverantörsfakturan.'}
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

      {/* Extraction produced nothing (a crashed deferred worker swept back to
          'received', a swallowed failure, or a skipped run): offer the AI
          re-run right where the empty fields are. Mirrors the error-state
          retry above, which only renders when error_message is set. HEIC is
          excluded: Bedrock cannot read it, so a retry cannot succeed. */}
      {!inFlight &&
        !isResolved &&
        !item.error_message &&
        hasAi &&
        !!item.document_id &&
        !hasAnyExtractedField(data) &&
        docMime !== 'image/heic' &&
        docMime !== 'image/heif' && (
          <div className="border-b px-4 py-2">
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
              {t('retry_extraction')}
            </Button>
          </div>
        )}

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        {/* The proposed kontering comes first: it is the decision. The fields
            are the evidence you check when the decision looks wrong, so they
            fold. Reading order used to be the other way round, which meant
            scrolling past nine values to reach the one thing to approve.
            Suppressed while extraction is in flight: a proposal computed from
            empty fields would be an invitation to book nothing. */}
        {showBookingBridge && !inFlight && (
          <ProposedBooking itemId={item.id} onLoaded={setProposal} />
        )}

        <details className="group" open={!isLinkedToTransaction}>
          <summary className="flex items-center gap-1.5 cursor-pointer list-none text-xs uppercase tracking-wide text-muted-foreground font-medium hover:text-foreground">
            <ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90" />
            <span className="flex-1">{t('fields_summary')}</span>
            {/* A count, not a score. "5 av 12" read as a bad extraction even
                when a kvitto had given up everything a kvitto has: half those
                twelve fields only exist on an invoice. */}
            {!inFlight && countExtractedFields(data) > 0 && (
              <span className="tabular-nums normal-case tracking-normal">
                {t('fields_filled', { count: countExtractedFields(data) })}
              </span>
            )}
            {/* Kept from main: the fields are readable at rail width but not
                comfortable, so the expand still earns its place inside the
                fold. stopPropagation, or the summary would toggle under it. */}
            {!inFlight && (hasAnyExtractedField(data) || hasAi) && (
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); setFieldsExpanded(true) }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault(); e.stopPropagation(); setFieldsExpanded(true)
                  }
                }}
                aria-label={t('expand_fields')}
                title={t('expand_fields')}
                className="p-1 -m-1 hover:text-foreground"
              >
                <Maximize2 className="h-3.5 w-3.5" />
              </span>
            )}
          </summary>
          <div className="pt-3">
        {inFlight ? (
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
              Uppgradera för att låta {appName} läsa av leverantör, belopp och
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
        </details>
      </div>

      {/* Actions: hidden while AI extraction is in flight (optimistic
          placeholder AND staged 'processing' rows alike). */}
      {!inFlight && (
      <div className="border-t px-4 py-3 space-y-2">
        {isProcessed && item.created_supplier_invoice_id ? (
          <Link href={`/supplier-invoices/${item.created_supplier_invoice_id}`} className="block">
            <Button variant="default" size="sm" className="w-full">
              <ArrowRight className="h-3.5 w-3.5 mr-1.5" />
              Öppna leverantörsfaktura
            </Button>
          </Link>
        ) : isBookedDirectly && bookedEntryId ? (
          <Link href={`/bookkeeping/${bookedEntryId}`} className="block">
            <Button variant="default" size="sm" className="w-full">
              <ArrowRight className="h-3.5 w-3.5 mr-1.5" />
              Öppna verifikation
            </Button>
          </Link>
        ) : isLinkedToTransaction && item.matched_transaction_id ? (
          <>
            {/* The transaction is booked but this item's underlag is not on
                its verifikat (#1548): say so, link the verifikat, and keep
                "Avbryt matchning" as the way out. No booking bridge: the
                book routes 409 on an already-booked transaction. */}
            {underlagDivergent && item.matched_transaction_journal_entry_id && (
              <AttnLine
                className="pb-1"
                action={{
                  label: t('underlag_open_verification'),
                  href: `/bookkeeping/${item.matched_transaction_journal_entry_id}`,
                }}
              >
                {t(
                  UNDERLAG_STATUS_MESSAGE_KEY[
                    (item.underlag_status ?? 'unknown') as Exclude<UnderlagStatus, 'anchored'>
                  ],
                )}
              </AttnLine>
            )}
            {/* Matched-to-tx state: show the bridge to booking. The user
                picks one of two actions: book themselves with the
                deterministic dialog, or hand off to the assistant. */}
            {showBookingBridge && onAskAssistant && (
              <Button
                variant="default"
                size="sm"
                className="w-full"
                onClick={() => onAskAssistant(item.matched_transaction_id!)}
              >
                Fråga assistenten
              </Button>
            )}
            {/* One control, and its scope is the whole verifikat. It opens
                pre-filled with the proposal when there is one and empty when
                there is not, so there is no separate "book manually" path to
                choose between. Nothing posts from here without the form's own
                review step (convention 14). */}
            {showBookingBridge && (
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => setEditOpen(true)}
              >
                {proposal?.lines.length ? t('review_and_book') : t('book_manually')}
              </Button>
            )}
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
                  onClick={onRegisterExpense}
                  className="flex flex-col items-start gap-1"
                >
                  <span>Registrera som utlägg</span>
                  <span className="text-xs text-muted-foreground">
                    För köp du eller en anställd betalat privat.
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
        {isLinkedToTransaction &&
          (item.matched_transaction_id ? (
            <Link
              href={`/transactions?highlight=${item.matched_transaction_id}`}
              className="w-full"
            >
              <Badge
                variant="secondary"
                className="w-full justify-center text-[10px] hover:bg-secondary/80"
              >
                <Link2 className="h-2.5 w-2.5 mr-1" />
                Kopplad till transaktion
              </Badge>
            </Link>
          ) : (
            <Badge variant="secondary" className="w-full justify-center text-[10px]">
              <Link2 className="h-2.5 w-2.5 mr-1" />
              Kopplad till transaktion
            </Badge>
          ))}
      </div>
      )}

      <EditKonteringDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        itemId={item.id}
        documentId={item.document_id ?? null}
        documentMime={docMime}
        documentUrl={null}
        fileName={item.fileName ?? null}
        transactionId={item.matched_transaction_id ?? null}
        // BFL 5 kap 6-7 § wants datum för affärshändelsen. The proposal's date
        // is the bank's, which is the event for a matched purchase. Without one
        // the document's own date is the next best truth; today is the day
        // somebody opened a dialog and is nobody's business event. The field is
        // editable either way, but a silent wrong default is not checked.
        entryDate={
          proposal?.entry_date ??
          data?.invoice?.invoiceDate ??
          new Date().toISOString().slice(0, 10)
        }
        description={data?.supplier?.name ?? item.email_subject ?? 'Underlag'}
        // No proposal is not the same as no amount: the matched bank row still
        // knows what left the account and where. The fallback skeleton keeps
        // the kronor figure in the form (regression report 2026-08-12: match,
        // "Bokför manuellt", and the amount no longer followed along).
        lines={proposal?.lines.length ? proposal.lines : (proposal?.fallback_lines ?? [])}
        matchedTransaction={proposal?.transaction ?? null}
        onBooked={() => {
          setEditOpen(false)
          // Realtime refreshes the list, but this rail renders from the
          // `selected` object the parent already fetched, so it would keep
          // offering "Granska och bokför" for an underlag that now has a
          // verifikat, and a second press would post a duplicate.
          onBookedLocally?.()
        }}
      />

      {/* Expanded fields editor: same autosaving list as the rail, at a
          readable size. Convention 13: centered modal. */}
      <Dialog open={fieldsExpanded} onOpenChange={setFieldsExpanded}>
        <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('fields_summary')}</DialogTitle>
          </DialogHeader>
          <EditableFieldsList
            itemId={item.id}
            data={data ?? emptyExtraction()}
            disabled={isResolved}
            onUpdated={onFieldsUpdated}
            variant="expanded"
          />
        </DialogContent>
      </Dialog>
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
  variant = 'rail',
}: {
  itemId: string
  data: InvoiceExtractionResult
  disabled: boolean
  onUpdated: (data: InvoiceExtractionResult) => void
  /** 'rail' = the compact inline list in the side rail; 'expanded' = the
   *  larger two-column layout inside the fields dialog. Same behavior,
   *  different density. */
  variant?: 'rail' | 'expanded'
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
        if (!res.ok) {
          // 409 means the item is already linked to a supplier invoice and
          // the server has rejected the edit. Name that in the title; the
          // description carries the specific Swedish message ("Posten är
          // redan kopplad…") for every status.
          const failure = await resolveFailure(res)
          toast({
            variant: 'destructive',
            title: res.status === 409 ? 'Posten är låst' : 'Kunde inte spara',
            description: failure.message,
          })
          setDrafts((prev) => ({ ...prev, [key]: readField(data, key) }))
          return
        }
        const json = await res.json()
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
    <div
      className={
        variant === 'expanded'
          ? 'grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3'
          : 'space-y-2'
      }
    >
      {shownFields.map((f) => (
        <div key={f.key} className="flex flex-col gap-0.5">
          <div className="flex items-center justify-between gap-2">
            <label
              // The rail and the expanded dialog can be mounted at the same
              // time: the variant keeps the input ids unique between them.
              htmlFor={`field-${variant}-${f.key}`}
              className={cn(
                'uppercase tracking-wide text-muted-foreground/80',
                variant === 'expanded' ? 'text-xs' : 'text-[10px]'
              )}
            >
              {f.label}
            </label>
            <AiFilledIndicator
              active={drafts[f.key].trim() !== '' && !edited[f.key]}
              title="Ifyllt av AI: kontrollera mot dokumentet"
            />
          </div>
          <Input
            id={`field-${variant}-${f.key}`}
            type={f.type}
            inputMode={f.inputMode}
            value={drafts[f.key]}
            onChange={(e) => onChange(f.key, e.target.value)}
            onBlur={() => onBlur(f.key)}
            disabled={disabled}
            placeholder="-"
            className={cn(
              variant === 'expanded'
                ? 'h-9 text-sm border-border bg-transparent px-3 focus-visible:border-ring'
                : 'h-8 text-sm border-transparent bg-transparent px-2 -mx-2 hover:border-border focus-visible:border-ring',
              drafts[f.key] === '' && 'text-muted-foreground/50 italic'
            )}
          />
        </div>
      ))}
      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setShowAllFields(true)}
          className={cn(
            'text-[11px] text-muted-foreground hover:text-foreground hover:underline pt-1 text-left',
            variant === 'expanded' && 'sm:col-span-2'
          )}
        >
          Visa fakturafält ({hiddenCount})
        </button>
      )}
      {vatRows.length > 0 && (
        <div className={cn('pt-2 border-t mt-3', variant === 'expanded' && 'sm:col-span-2 mt-1')}>
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
        <p
          className={cn(
            'text-[10px] text-muted-foreground/70 pt-2',
            variant === 'expanded' && 'sm:col-span-2 text-xs'
          )}
        >
          Posten är kopplad till en leverantörsfaktura: fälten kan inte ändras.
        </p>
      )}
    </div>
  )
}
