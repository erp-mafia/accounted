'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isEntityType, ownerSettlementAccount } from '@/lib/company/entity-type'
import { useTranslations } from 'next-intl'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import {
  ArrowUpTrayIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  DocumentTextIcon,
  LockClosedIcon,
  PencilSquareIcon,
  PlusIcon,
  ReceiptRefundIcon,
  SparklesIcon,
  SpinnerIcon,
  XMarkIcon,
} from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { PageHeader } from '@/components/ui/page-header'
import { HelpPopover } from '@/components/ui/help-popover'
import { AttnLine } from '@/components/ui/attn-line'
import { LateReveal, Skeleton } from '@/components/ui/skeleton'
import { EmptyState, LoadError } from '@/components/ui/empty-state'
import { Checkbox } from '@/components/ui/checkbox'
import { TH_CLASS, TD_CLASS, HOVER_REVEAL_CLASS, QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { ContextPicker } from '@/components/common/ContextPicker'
import AccountCombobox from '@/components/bookkeeping/AccountCombobox'
import InboxDocumentPicker, { type AvailableInboxDoc } from '@/components/bookkeeping/InboxDocumentPicker'
import DocumentViewerPane from '@/components/bookkeeping/DocumentViewerPane'
import LineDimensionFields from '@/components/dimensions/LineDimensionFields'
import { useAccounts, useBookingTemplates, useCompanySettings, useEmployees } from '@/lib/reference-data/hooks'
import type { BookingTemplateWithUsage } from '@/lib/reference-data/fetchers'
import { TemplateForm } from '@/components/settings/TemplateForm'
import { applyTemplate, deriveTemplateLinesFromBooking } from '@/lib/bookkeeping/template-library'
import { BOOKING_TEMPLATES, findMatchingTemplates } from '@/lib/bookkeeping/booking-templates'
import { useProposalPreview } from '@/lib/hooks/use-proposal-preview'
import { isInboxItemUnbooked } from '@/lib/documents/inbox-item-state'
import { isGeneratedVatAccount, isReverseChargeBasisLeg } from '@/lib/bookkeeping/vat-entries'
import { PINNED_JURISDICTION, resolveAccountRole } from '@/lib/bookkeeping/account-roles'
import { useCapability, useCompanyOptional } from '@/contexts/CompanyContext'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { formatAmountInput } from '@/lib/money'
import { lineBalance } from '@/lib/bookkeeping/line-balance'
import { ACCOUNT_NUMBER_RE } from '@/lib/invariants'
import { useToast } from '@/components/ui/use-toast'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { formatCurrency, formatDate, formatAmount, formatRowAmount } from '@/lib/utils'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { postDocumentForm, uploadViaSignedUrl } from '@/lib/documents/direct-upload'
import { expenseClaimantKey, outstandingByClaimant as groupOutstandingByClaimant } from '@/lib/expenses/expense-payout-candidates'
import { lastOwnerClaimantName } from '@/lib/expenses/payer'
import {
  PLAIN_DOCUMENT_UPLOAD_URL,
  documentIdFromPlainUpload,
  plainDocumentUploadForm,
  underlagUploadRoute,
} from '@/lib/documents/underlag-upload-route'
import { exceedsHostedUploadLimit } from '@/lib/documents/upload-size'
import { INBOX_UPLOAD_ACCEPT } from '@/lib/documents/upload-types'
import { CURRENCIES, type BookingTemplateLibrary } from '@/types'
import { todayIsoStockholm } from '@/lib/dates/iso'

interface ExpenseClaim {
  id: string
  employee_id: string | null
  claimant_name: string
  description: string
  expense_date: string
  amount_sek: number
  vat_sek: number
  currency: string
  amount_in_currency: number | null
  expense_account: string
  liability_account: string
  status: 'registered' | 'paid'
  created_at: string
  /** Registered and on no payslip: the server's answer (lib/salary/expense-claim-payout-state.ts). */
  awaits_payout: boolean
  /** The salary run that repays the claim, while it is registered and on a payslip. */
  salary_run: { salary_run_id: string; payment_date: string } | null
  journal_entry_id: string | null
  document: { id: string; file_name: string | null } | null
  batch: { id: string; payout_date: string } | null
}

interface InboxOption {
  id: string
  document_id: string | null
  label: string
  extracted: ExtractedReceipt | null
}

interface PayoutBatch {
  id: string
  payout_date: string
  claimant_name: string
  cash_account: string
  total_sek: number
  journal_entry_id: string | null
}

interface ExtractedReceipt {
  totals?: { total?: number; vatAmount?: number } | null
  invoice?: { invoiceDate?: string | null; currency?: string | null } | null
  supplier?: { name?: string | null } | null
  lineItems?: Array<{ description?: string | null }> | null
}

const OWNER_VALUE = 'owner'
const NO_RECEIPT_VALUE = 'none'
type SellerCountry = 'se' | 'abroad' | 'eu' | 'noneu'

interface BookingRow {
  key: number
  account: string
  debit: string
  credit: string
}
let bookingRowKey = 0
const nextRowKey = () => ++bookingRowKey

const EXCLUDED_TEMPLATE_CATEGORIES = ['salary', 'year_end', 'vat', 'tax_account', 'private_transfer']
/** 2645 in the SE pack. PINNED_JURISDICTION: CompanyContext's company is loaded without its jurisdiction. */
const FOREIGN_REVERSE_CHARGE_INPUT_VAT = resolveAccountRole(PINNED_JURISDICTION, 'input_vat_reverse_charge_foreign')
/** Expense-shaped library template: every business line is a debit and no
 *  2614/2645 legs: the country selector owns the reverse-charge variant. */
const isExpenseLibraryTemplate = (tpl: BookingTemplateWithUsage) => {
  const business = tpl.lines.filter((l) => l.type === 'business')
  if (business.length === 0) return false
  if (!business.every((l) => l.side === 'debit')) return false
  if (tpl.lines.some((l) => l.account === '2614' || l.account === FOREIGN_REVERSE_CHARGE_INPUT_VAT)) return false
  return true
}

/** Deferred inbox extraction usually lands within ~20 s; stop polling after this. */
const EXTRACTION_POLL_LIMIT_MS = 90_000
const EXTRACTION_POLL_INTERVAL_MS = 3_000

type UploadState =
  | { phase: 'idle' }
  | { phase: 'uploading'; fileName: string }
  | { phase: 'extracting'; fileName: string; inboxItemId: string; documentId: string | null }
  | {
      phase: 'done'
      fileName: string
      /** Null for a receipt stored without the document inbox (no AI capability). */
      inboxItemId: string | null
      documentId: string | null
      extracted: ExtractedReceipt | null
    }
  | { phase: 'error'; message: string }

export default function ExpenseClaimsPage() {
  const t = useTranslations('expense_claims')
  const tCommon = useTranslations('common')
  // The document inbox (AI reading) is refused for a company without the AI
  // capability; the receipt is then stored through the plain documents upload.
  const receiptRoute = underlagUploadRoute({ hasAiCapability: useCapability(CAPABILITY.ai) })
  const tTpl = useTranslations('settings_booking_templates')
  const { toast } = useToast()
  const { canWrite } = useCanWrite()
  const router = useRouter()
  const searchParams = useSearchParams()
  const appliedDeepLink = useRef(false)

  const [claims, setClaims] = useState<ExpenseClaim[]>([])
  // The roster from the session cache (lib/reference-data).
  const { employees } = useEmployees()
  const { accounts } = useAccounts()
  const [inboxOptions, setInboxOptions] = useState<InboxOption[]>([])
  const [inboxLoaded, setInboxLoaded] = useState(false)
  const [payoutBatches, setPayoutBatches] = useState<PayoutBatch[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [statusFilter, setStatusFilter] = useState<'all' | 'registered' | 'paid'>('all')
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const [creating, setCreating] = useState(false)
  const [step, setStep] = useState<1 | 2>(1)
  const [paying, setPaying] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [deleting, setDeleting] = useState<ExpenseClaim | null>(null)

  // Create form
  const [description, setDescription] = useState('')
  const [expenseDate, setExpenseDate] = useState(todayIsoStockholm)
  const [amount, setAmount] = useState('')
  const [vatAmount, setVatAmount] = useState('')
  const [currency, setCurrency] = useState('SEK')
  const [expenseAccount, setExpenseAccount] = useState('5410')
  // Step 2 booking editor (the Bokio model): one owner of the rows at a
  // time. Seller country + cost account generate them, OR an applied
  // template owns them, OR a manual edit freezes them into `bookingRows`.
  const [sellerCountry, setSellerCountry] = useState<SellerCountry>('se')
  const [reverseCharge, setReverseCharge] = useState(false)
  const [bookingMode, setBookingMode] = useState<'choose' | 'book'>('choose')
  const { templates } = useBookingTemplates()
  const [templateSearch, setTemplateSearch] = useState('')
  const [appliedTemplate, setAppliedTemplate] = useState<{ name: string; description: string } | null>(null)
  const [bookingRows, setBookingRows] = useState<BookingRow[] | null>(null)
  const [showRowEditor, setShowRowEditor] = useState(false)
  const [showSaveTemplate, setShowSaveTemplate] = useState(false)
  // Claim-level kostnadsställe/projekt: the service puts it on every cost
  // (class 3-8) row of the verifikat. Pickers only when dimensions are on.
  const { settings: companySettings } = useCompanySettings()
  const dimensionsEnabled = companySettings?.dimensions_enabled === true
  const [claimDims, setClaimDims] = useState<Record<string, string>>({})
  const [claimant, setClaimant] = useState(OWNER_VALUE)
  const [ownerName, setOwnerName] = useState('')
  const [inboxChoice, setInboxChoice] = useState(NO_RECEIPT_VALUE)
  const [showInboxPicker, setShowInboxPicker] = useState(false)
  const [upload, setUpload] = useState<UploadState>({ phase: 'idle' })
  // Split view: show the attached receipt beside the form so the user can
  // read the figures off it while booking. Auto-opens when a document exists.
  const [showReceipt, setShowReceipt] = useState(true)
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const pollAbort = useRef<{ cancelled: boolean }>({ cancelled: false })

  // Payout form
  const [payoutDate, setPayoutDate] = useState(todayIsoStockholm)
  const [cashAccount, setCashAccount] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/expense-claims')
      if (res.ok) {
        const { data } = await res.json()
        const rows: ExpenseClaim[] = data || []
        setClaims(rows)
        setLoadError(false)
        // "Jag, privat" opens with the name the owner's claims were last
        // registered under, as in the Underlag pane: an empty field books
        // as "Ägare", one more person to pay.
        setOwnerName((current) => current || lastOwnerClaimantName(rows) || '')
        // Prune ids that no longer exist or are no longer payable, so a
        // payout request never names a claim deleted or paid in another tab.
        setSelected((prev) => {
          const next = new Set(
            [...prev].filter((id) => rows.some((r) => r.id === id && r.awaits_payout)),
          )
          return next.size === prev.size ? prev : next
        })
      } else {
        setLoadError(true)
      }
    } catch {
      setLoadError(true)
    } finally {
      setLoading(false)
    }
  }, [])

  const loadInbox = useCallback(async () => {
    // Without the AI capability the screen uploads plainly (underlagUploadRoute) and
    // offers no inbox items: none of them is read, so none has a name to pick it by.
    if (receiptRoute !== 'inbox') {
      setInboxLoaded(true)
      return
    }
    try {
      const res = await fetch('/api/extensions/ext/invoice-inbox/items?limit=100')
      if (!res.ok) return
      const json = await res.json()
      const items = (json?.data?.items ?? []) as Array<{
        id: string
        document_id: string | null
        created_journal_entry_id: string | null
        created_supplier_invoice_id: string | null
        extracted_data?: ExtractedReceipt | null
      }>
      setInboxOptions(
        items
          .filter((i) => i.document_id && isInboxItemUnbooked(i))
          .map((i) => ({
            id: i.id,
            document_id: i.document_id,
            label:
              [i.extracted_data?.supplier?.name, i.extracted_data?.totals?.total]
                .filter(Boolean)
                .join(' · ') || i.id.slice(0, 8),
            extracted: (i.extracted_data as ExtractedReceipt | null) ?? null,
          })),
      )
    } catch {
      setInboxOptions([])
    } finally {
      setInboxLoaded(true)
    }
  }, [receiptRoute])

  const loadPayouts = useCallback(() => {
    fetch('/api/expense-claims/payouts')
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => setPayoutBatches(json?.data ?? []))
      .catch(() => {})
  }, [])

  useEffect(() => {
    load()
    loadInbox()
    loadPayouts()
  }, [load, loadInbox, loadPayouts])

  const cashAccounts = useMemo(
    () => accounts.filter((a) => /^19\d{2}$/.test(a.account_number)),
    [accounts],
  )
  useEffect(() => {
    if (!cashAccount && cashAccounts.length > 0) {
      setCashAccount(cashAccounts[0].account_number)
    }
  }, [cashAccount, cashAccounts])

  const accountName = useCallback(
    (num: string) => accounts.find((a) => a.account_number === num)?.account_name ?? '',
    [accounts],
  )

  const visibleClaims = useMemo(
    () => claims.filter((c) => statusFilter === 'all' || c.status === statusFilter),
    [claims, statusFilter],
  )

  const outstandingByClaimant = useMemo(() => groupOutstandingByClaimant(claims), [claims])

  const selectableIds = useMemo(
    () => visibleClaims.filter((c) => c.awaits_payout).map((c) => c.id),
    [visibleClaims],
  )
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.has(id))
  const someSelected = selectableIds.some((id) => selected.has(id))
  const selectedClaims = useMemo(
    () => claims.filter((c) => selected.has(c.id)),
    [claims, selected],
  )
  const selectedTotal = selectedClaims.reduce((sum, c) => sum + c.amount_sek, 0)
  const selectionValid =
    selectedClaims.length > 0 &&
    new Set(selectedClaims.map(expenseClaimantKey)).size === 1 &&
    new Set(selectedClaims.map((c) => c.liability_account)).size === 1

  // Entity type drives the owner liability account (AB creditor vs enskild
  // firma egen insättning); the server resolves the same way and is the
  // authority. Outside a provider we fall back to AB's 2893.
  const entityType = useCompanyOptional()?.company?.entity_type ?? null
  const ownerLiability = isEntityType(entityType) ? ownerSettlementAccount(entityType, 'contribution') : '2893'
  const liabilityAccount = claimant === OWNER_VALUE ? ownerLiability : '2820'
  const parsedAmount = parseFloat(amount) || 0
  const parsedVat = parseFloat(vatAmount) || 0
  const netAmount = Math.max(0, parsedAmount - parsedVat)

  // Seller country resolves the VAT mechanics: Sweden books the receipt VAT
  // on 2641. Foreign sellers default to gross-as-cost: hotel, restaurant,
  // taxi and the like are taxed where performed (ML 6 kap.), the foreign VAT
  // is not deductible and no omvänd skattskyldighet applies. Reverse charge
  // (goods, services under huvudregeln like SaaS) is an explicit opt-in: the
  // server books the cost against the claim's liability the way a bank row
  // is booked (fiktiv moms, and the basis pair unless the cost account
  // reports ruta 20-24 itself).
  const reverseChargeBooked = sellerCountry !== 'se' && sellerCountry !== 'abroad' && reverseCharge
  const reverseChargePreview = useProposalPreview(
    reverseChargeBooked && parsedAmount > 0 && ACCOUNT_NUMBER_RE.test(expenseAccount)
      ? {
          amount: parsedAmount,
          pair: {
            debit_account: expenseAccount,
            credit_account: liabilityAccount,
            vat_treatment: 'reverse_charge',
            reverse_charge_supplier_type: sellerCountry === 'eu' ? 'eu_business' : 'non_eu_business',
          },
        }
      : null,
  )
  const generatedRows = useMemo<BookingRow[]>(() => {
    if (sellerCountry === 'se') {
      return [
        { key: -1, account: expenseAccount, debit: formatAmountInput(netAmount, '.'), credit: '' },
        ...(parsedVat > 0
          ? [{ key: -2, account: '2641', debit: formatAmountInput(parsedVat, '.'), credit: '' }]
          : []),
      ]
    }
    if (!reverseChargeBooked) {
      return [
        { key: -1, account: expenseAccount, debit: formatAmountInput(parsedAmount, '.'), credit: '' },
      ]
    }
    // The claim's liability is the editor's own credit row, so the money leg
    // stays out; the cost line leads, the moms and basis legs follow it.
    const isGenerated = (account: string) => isGeneratedVatAccount(account) || isReverseChargeBasisLeg(account)
    return reverseChargePreview.lines
      .filter((line) => !line.settlement)
      .sort((a, b) => Number(isGenerated(a.account)) - Number(isGenerated(b.account)))
      .map((line, i) => ({
        key: -(i + 1),
        account: line.account,
        debit: line.side === 'debet' ? formatAmountInput(line.amount, '.') : '',
        credit: line.side === 'kredit' ? formatAmountInput(line.amount, '.') : '',
      }))
  }, [sellerCountry, reverseChargeBooked, reverseChargePreview.lines, expenseAccount, netAmount, parsedAmount, parsedVat])

  const editorRows = bookingRows ?? generatedRows
  const { totalDebit, totalCredit, difference: bookingDifference } = lineBalance([
    ...editorRows.map((r) => ({ debit_amount: r.debit, credit_amount: r.credit })),
    { credit_amount: parsedAmount },
  ])
  const bookingBalanced = bookingDifference === 0
  const bookingRowsValid = editorRows.every((r) => {
    const d = parseFloat(r.debit) || 0
    const c = parseFloat(r.credit) || 0
    return ACCOUNT_NUMBER_RE.test(r.account) && (d > 0) !== (c > 0)
  })

  interface ChooserItem {
    id: string
    name: string
    description: string
    lastUsedAt: string | null
    library?: BookingTemplateWithUsage
    staticAccount?: string
  }
  const chooserPool = useMemo<ChooserItem[]>(() => {
    const libraryItems: ChooserItem[] = templates
      .filter((tpl) => tpl.is_active && !tpl.is_hidden)
      .filter((tpl) => !EXCLUDED_TEMPLATE_CATEGORIES.includes(tpl.category))
      .filter(isExpenseLibraryTemplate)
      .map((tpl) => ({
        id: tpl.id,
        name: tpl.name,
        description: tpl.description ?? '',
        lastUsedAt: tpl.last_used_at,
        library: tpl,
      }))
    const libraryNames = new Set(libraryItems.map((item) => item.name))
    // The static categorization catalog carries the everyday cost templates
    // the seeded library lacks (Programvara/SaaS, IT-tjänster, ...): expose
    // them as account-picking templates. Reverse-charge variants stay out:
    // Säljarens land owns that axis.
    const staticItems: ChooserItem[] = BOOKING_TEMPLATES.filter(
      (tpl) =>
        tpl.direction === 'expense' &&
        tpl.vat_treatment !== 'reverse_charge' &&
        !libraryNames.has(tpl.name_sv),
    ).map((tpl) => ({
      id: `static:${tpl.id}`,
      name: tpl.name_sv,
      description: tpl.description_sv,
      lastUsedAt: null,
      staticAccount: tpl.debit_account_ab ?? tpl.debit_account,
    }))
    return [...libraryItems, ...staticItems]
     
  }, [templates])

  // Recommendations ride the categorization matcher against the step-1
  // description; static hits map by id, library hits by Swedish name.
  const localRecommendedIds = useMemo(() => {
    if (!description.trim()) return [] as string[]
    const byId = new Map(chooserPool.map((item) => [item.id, item]))
    const byName = new Map(chooserPool.map((item) => [item.name, item]))
    return findMatchingTemplates(
      {
        description,
        merchant_name: null,
        amount: -(parsedAmount || 1),
        mcc_code: null,
      } as never,
    )
      .map((m) => (byId.get(`static:${m.template.id}`) ?? byName.get(m.template.name_sv))?.id)
      .filter((id): id is string => Boolean(id))
      .slice(0, 3)
  }, [chooserPool, description, parsedAmount])

  // AI fallback: only when the chooser is open and the keyword matcher drew a
  // blank (unknown merchants like "Supabase Pte. Ltd."). Debounced; an empty
  // answer is a valid answer, and a stale response for an edited description
  // is dropped.
  const [aiSuggestedIds, setAiSuggestedIds] = useState<string[]>([])
  const [aiPending, setAiPending] = useState(false)
  const aiRequestKey = useRef<string | null>(null)
  useEffect(() => {
    const desc = description.trim()
    const chooserVisible = creating && step === 2 && bookingMode === 'choose'
    if (!chooserVisible || desc.length < 2 || localRecommendedIds.length > 0 || chooserPool.length === 0) {
      setAiPending(false)
      return
    }
    const key = desc.toLocaleLowerCase('sv-SE')
    if (aiRequestKey.current === key) return
    setAiPending(true)
    const timer = setTimeout(() => {
      aiRequestKey.current = key
      // Drop suggestions for the previous description: the loading row is
      // clearer than silently swapping lines under the user's cursor.
      setAiSuggestedIds((prev) => (prev.length ? [] : prev))
      fetch('/api/expense-claims/suggest-template', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: desc,
          amount: parsedAmount || undefined,
          candidates: chooserPool.slice(0, 80).map((item) => ({
            id: item.id,
            name: item.name,
            hint: item.description ? item.description.slice(0, 240) : undefined,
          })),
        }),
      })
        .then((res) => (res.ok ? res.json() : null))
        .then((json) => {
          if (aiRequestKey.current !== key) return
          setAiSuggestedIds(json?.data?.template_ids ?? [])
        })
        .catch(() => {})
        .finally(() => {
          if (aiRequestKey.current === key) setAiPending(false)
        })
    }, 600)
    return () => clearTimeout(timer)
  }, [creating, step, bookingMode, description, parsedAmount, localRecommendedIds, chooserPool])

  const templateSections = useMemo(() => {
    const q = templateSearch.trim().toLocaleLowerCase('sv-SE')
    const pool = chooserPool.filter(
      (item) =>
        !q ||
        item.name.toLocaleLowerCase('sv-SE').includes(q) ||
        item.description.toLocaleLowerCase('sv-SE').includes(q),
    )
    if (q) return { recommended: [], recent: [], all: pool.slice(0, 30), recommendedSource: null }
    const byId = new Map(pool.map((item) => [item.id, item]))
    // The keyword matcher wins; the AI route only fills in when it drew blank.
    const recommendedSource: 'local' | 'ai' | null =
      localRecommendedIds.length > 0 ? 'local' : aiSuggestedIds.length > 0 ? 'ai' : null
    const sourceIds = recommendedSource === 'local' ? localRecommendedIds : aiSuggestedIds
    const recommended = sourceIds
      .map((id) => byId.get(id))
      .filter((item): item is ChooserItem => Boolean(item))
      .slice(0, 3)
    const taken = new Set(recommended.map((item) => item.id))
    const recent = pool
      .filter((item) => item.lastUsedAt && !taken.has(item.id))
      .sort((a, b) => (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? ''))
      .slice(0, 3)
    for (const item of recent) taken.add(item.id)
    const all = pool.filter((item) => !taken.has(item.id)).slice(0, 30)
    return { recommended, recent, all, recommendedSource }
  }, [chooserPool, templateSearch, localRecommendedIds, aiSuggestedIds])

  /** Bokio's semantic: the template picks the account/type, the country picks
   *  the VAT variant. Static and single-cost library templates map onto the
   *  generator; multi-line library templates apply their rows verbatim. */
  const chooseTemplate = (item: ChooserItem) => {
    setAppliedTemplate({ name: item.name, description: item.description })
    if (item.staticAccount) {
      setExpenseAccount(item.staticAccount)
      setBookingRows(null)
    } else if (item.library) {
      const tpl = item.library
      const businessDebits = tpl.lines.filter((l) => l.type === 'business' && l.side === 'debit')
      if (businessDebits.length === 1) {
        setExpenseAccount(businessDebits[0].account)
        setBookingRows(null)
      } else {
        setBookingRows(
          applyTemplate(tpl.lines, parsedAmount)
            .filter((l) => !/^(15|19|24)/.test(l.account_number) && l.account_number !== liabilityAccount)
            .map((l) => ({
              key: nextRowKey(),
              account: l.account_number,
              debit: l.debit_amount || '',
              credit: l.credit_amount || '',
            })),
        )
      }
    }
    setBookingMode('book')
  }
  const chooseManual = () => {
    setAppliedTemplate(null)
    setBookingRows(null)
    setBookingMode('book')
  }

  const applyCountry = (country: SellerCountry) => {
    setSellerCountry(country)
    setReverseCharge(false)
    setBookingRows(null)
  }

  const editRow = (key: number, patch: Partial<BookingRow>) => {
    const base = bookingRows ?? editorRows
    setBookingRows(base.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  }
  const removeRow = (key: number) => {
    const base = bookingRows ?? editorRows
    setBookingRows(base.filter((r) => r.key !== key))
  }
  const addRow = () => {
    const base = bookingRows ?? editorRows
    setBookingRows([...base, { key: nextRowKey(), account: '', debit: '', credit: '' }])
  }


  const templateSeedLines = useMemo(
    () =>
      deriveTemplateLinesFromBooking(
        [
          ...editorRows.map((r) => ({
            account_number: r.account,
            debit_amount: r.debit,
            credit_amount: r.credit,
            line_description: '',
          })),
          { account_number: liabilityAccount, debit_amount: '', credit_amount: formatAmountInput(parsedAmount, '.'), line_description: '' },
        ],
        Object.fromEntries(accounts.map((a) => [a.account_number, a.account_name])),
      ),
    [editorRows, liabilityAccount, parsedAmount, accounts],
  )
  /** The attached receipt's document, from either path (upload or inbox). */
  const receiptDoc = useMemo(() => {
    if ((upload.phase === 'done' || upload.phase === 'extracting') && upload.documentId) {
      return { id: upload.documentId, fileName: upload.fileName }
    }
    if (inboxChoice !== NO_RECEIPT_VALUE) {
      const opt = inboxOptions.find((i) => i.id === inboxChoice)
      if (opt?.document_id) return { id: opt.document_id, fileName: opt.label }
    }
    return null
  }, [upload, inboxChoice, inboxOptions])
  /** No receipt from either path: the claim registers, but lacks its underlag. */
  const receiptMissing =
    (upload.phase === 'idle' || upload.phase === 'error') && inboxChoice === NO_RECEIPT_VALUE

  const claimantDisplay =
    claimant === OWNER_VALUE
      ? ownerName || t('owner_fallback_name')
      : (() => {
          const e = employees.find((x) => x.id === claimant)
          return e ? `${e.first_name} ${e.last_name}` : ''
        })()

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function resetCreate() {
    pollAbort.current.cancelled = true
    setDescription('')
    setAmount('')
    setVatAmount('')
    setCurrency('SEK')
    setExpenseAccount('5410')
    setClaimant(OWNER_VALUE)
    setInboxChoice(NO_RECEIPT_VALUE)
    setUpload({ phase: 'idle' })
    setShowReceipt(true)
    setExpenseDate(todayIsoStockholm())
    setSellerCountry('se')
    setReverseCharge(false)
    setBookingMode('choose')
    setTemplateSearch('')
    setAppliedTemplate(null)
    setBookingRows(null)
    setShowRowEditor(false)
    setShowSaveTemplate(false)
    setClaimDims({})
    setStep(1)
    setCreating(false)
  }

  function setClaimDimension(dimNo: string, code: string | null) {
    setClaimDims((prev) => {
      const next = { ...prev }
      const trimmed = code?.trim()
      if (trimmed) next[dimNo] = trimmed
      else delete next[dimNo]
      return next
    })
  }

  /** Prefill only fields the user has not already filled in. */
  const applyExtraction = useCallback(
    (extracted: ExtractedReceipt | null, opts: { force?: boolean } = {}) => {
      if (!extracted) return
      const force = opts.force ?? false
      const total = extracted.totals?.total
      const vat = extracted.totals?.vatAmount
      const date = extracted.invoice?.invoiceDate
      const curr = extracted.invoice?.currency?.toUpperCase()
      const supplier = extracted.supplier?.name
      const firstLine = extracted.lineItems?.[0]?.description

      // force = the user actively picked this receipt, so its data replaces
      // whatever an earlier pick prefilled. Without force only empty fields
      // are filled (the AI-read-on-upload path, mid-typing).
      setAmount((prev) => (total == null ? prev : force || !prev ? String(total) : prev))
      setVatAmount((prev) => (vat == null ? prev : force || !prev ? String(vat) : prev))
      if (date) {
        setExpenseDate((prev) =>
          force || prev === todayIsoStockholm() ? date : prev,
        )
      }
      if (curr && (CURRENCIES as readonly string[]).includes(curr)) {
        setCurrency((prev) => (force || prev === 'SEK' ? curr : prev))
      }
      const suggested = [firstLine, supplier].filter(Boolean).join(', ')
      setDescription((prev) => (suggested && (force || !prev) ? suggested : prev))
    },
    [],
  )

  // Deep link from the document inbox: /expenses?new=1&inbox_item=<id> opens
  // the create dialog with that receipt picked and its extraction applied.
  useEffect(() => {
    if (appliedDeepLink.current) return
    // The link opens nothing for a read-only member.
    if (!canWrite || searchParams.get('new') !== '1') return
    const wanted = searchParams.get('inbox_item')
    if (wanted && !inboxLoaded) return // wait for the inbox answer (may be empty)
    appliedDeepLink.current = true
    setCreating(true)
    if (wanted) {
      const picked = inboxOptions.find((i) => i.id === wanted)
      if (picked) {
        setInboxChoice(picked.id)
        if (picked.extracted) applyExtraction(picked.extracted, { force: true })
      }
    }
    router.replace('/expenses')
  }, [searchParams, inboxOptions, inboxLoaded, applyExtraction, router, canWrite])

  const startUpload = useCallback(
    async (file: File) => {
      pollAbort.current = { cancelled: false }
      setUpload({ phase: 'uploading', fileName: file.name })
      try {
        if (receiptRoute === 'documents') {
          // Stored as a plain document: nothing reads it, the person fills
          // the fields. postDocumentForm handles a file over the body cap.
          const plainRes = await postDocumentForm(
            PLAIN_DOCUMENT_UPLOAD_URL,
            plainDocumentUploadForm(),
            file,
          )
          const plainJson = await plainRes.json().catch(() => null)
          const plainId = plainRes.ok ? documentIdFromPlainUpload(plainJson) : null
          if (pollAbort.current.cancelled) return
          if (!plainId) {
            setUpload({
              phase: 'error',
              message: plainRes.ok
                ? t('upload_failed')
                : getErrorMessage(plainJson ?? {}, { statusCode: plainRes.status }),
            })
            return
          }
          setUpload({
            phase: 'done',
            fileName: file.name,
            inboxItemId: null,
            documentId: plainId,
            extracted: null,
          })
          return
        }
        // Over the hosted body cap the receipt goes straight to Storage
        // (same response shape as the multipart route).
        let res: Response
        if (exceedsHostedUploadLimit(file.size)) {
          res = await uploadViaSignedUrl(file)
        } else {
          const form = new FormData()
          form.append('file', file)
          res = await fetch('/api/extensions/ext/invoice-inbox/upload', {
            method: 'POST',
            body: form,
          })
        }
        if (!res.ok) {
          const err = await res.json().catch(() => null)
          setUpload({
            phase: 'error',
            message: getErrorMessage(err ?? {}, { statusCode: res.status }),
          })
          return
        }
        const { data } = await res.json()
        const inboxItemId: string = data?.inbox_item_id
        const documentId: string | null = data?.document_id ?? null
        if (!inboxItemId) {
          setUpload({ phase: 'error', message: t('upload_failed') })
          return
        }
        // Synchronous extraction (email/agent paths) arrives in the response;
        // the web path defers and we poll for it below.
        if (data?.extracted_data) {
          applyExtraction(data.extracted_data as ExtractedReceipt)
          setUpload({
            phase: 'done',
            fileName: file.name,
            inboxItemId,
            documentId,
            extracted: data.extracted_data as ExtractedReceipt,
          })
          return
        }
        setUpload({ phase: 'extracting', fileName: file.name, inboxItemId, documentId })

        // Poll the inbox until the deferred AI extraction lands, then prefill.
        const deadline = Date.now() + EXTRACTION_POLL_LIMIT_MS
        const poll = async () => {
          if (pollAbort.current.cancelled) return
          try {
            const listRes = await fetch('/api/extensions/ext/invoice-inbox/items?limit=100')
            if (listRes.ok) {
              const json = await listRes.json()
              const item = (json?.data?.items ?? []).find(
                (i: { id: string }) => i.id === inboxItemId,
              )
              const extracted: ExtractedReceipt | null = item?.extracted_data ?? null
              const docId: string | null = item?.document_id ?? documentId
              if (extracted && (extracted.totals || extracted.supplier)) {
                if (!pollAbort.current.cancelled) {
                  applyExtraction(extracted)
                  setUpload({
                    phase: 'done',
                    fileName: file.name,
                    inboxItemId,
                    documentId: docId,
                    extracted,
                  })
                }
                return
              }
              if (item?.status === 'error') {
                setUpload({
                  phase: 'done',
                  fileName: file.name,
                  inboxItemId,
                  documentId: docId,
                  extracted: null,
                })
                return
              }
            }
          } catch {
            // transient; keep polling until the deadline
          }
          if (Date.now() < deadline) {
            setTimeout(poll, EXTRACTION_POLL_INTERVAL_MS)
          } else if (!pollAbort.current.cancelled) {
            // Extraction never landed: the receipt is still uploaded and usable.
            setUpload({
              phase: 'done',
              fileName: file.name,
              inboxItemId,
              documentId,
              extracted: null,
            })
          }
        }
        setTimeout(poll, EXTRACTION_POLL_INTERVAL_MS)
      } catch {
        setUpload({ phase: 'error', message: t('upload_failed') })
      }
    },
    [applyExtraction, receiptRoute, t],
  )

  function onFileChosen(files: FileList | null) {
    const file = files?.[0]
    if (file) startUpload(file)
  }

  async function handleCreate() {
    setSubmitting(true)
    try {
      const inbox = inboxOptions.find((i) => i.id === inboxChoice)
      const uploaded =
        upload.phase === 'done' || upload.phase === 'extracting'
          ? { inboxItemId: upload.inboxItemId, documentId: upload.documentId }
          : null
      const body: Record<string, unknown> = {
        description,
        expense_date: expenseDate,
        amount: parsedAmount,
        vat_amount: parsedVat,
        currency,
        expense_account: expenseAccount,
      }
      if (claimant === OWNER_VALUE) body.claimant_name = ownerName || t('owner_fallback_name')
      else body.employee_id = claimant
      // The booking editor's rows plus the locked liability line; amounts in
      // claim currency, converted by the service at the booking rate.
      body.lines = [
        ...editorRows.map((row) => ({
          account_number: row.account,
          debit_amount: parseFloat(row.debit) || 0,
          credit_amount: parseFloat(row.credit) || 0,
        })),
        { account_number: liabilityAccount, debit_amount: 0, credit_amount: parsedAmount },
      ]
      if (dimensionsEnabled && Object.keys(claimDims).length > 0) body.dimensions = claimDims
      if (uploaded) {
        if (uploaded.inboxItemId) body.inbox_item_id = uploaded.inboxItemId
        if (uploaded.documentId) body.document_id = uploaded.documentId
      } else if (inbox) {
        body.inbox_item_id = inbox.id
        body.document_id = inbox.document_id
      }

      const res = await fetch('/api/expense-claims', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (res.ok) {
        toast({ title: t('created') })
        resetCreate()
        await Promise.all([load(), loadInbox()])
      } else {
        const result = await res.json()
        toast({
          title: t('create_failed'),
          description: getErrorMessage(result, { statusCode: res.status }),
          variant: 'destructive',
        })
      }
    } catch {
      toast({ title: t('create_failed'), variant: 'destructive' })
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDelete() {
    if (!deleting) return
    setSubmitting(true)
    try {
      const res = await fetch(`/api/expense-claims/${deleting.id}`, { method: 'DELETE' })
      if (res.ok) {
        toast({ title: t('deleted') })
        setDeleting(null)
        await load()
      } else {
        const result = await res.json()
        toast({
          title: t('delete_failed'),
          description: getErrorMessage(result, { statusCode: res.status }),
          variant: 'destructive',
        })
      }
    } catch {
      toast({ title: t('delete_failed'), variant: 'destructive' })
    } finally {
      setSubmitting(false)
    }
  }

  async function handlePayout() {
    setSubmitting(true)
    try {
      const res = await fetch('/api/expense-claims/payouts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          claim_ids: selectedClaims.map((c) => c.id),
          payout_date: payoutDate,
          cash_account: cashAccount,
        }),
      })
      if (res.ok) {
        toast({ title: t('payout_created') })
        setSelected(new Set())
        setPaying(false)
        await load()
        loadPayouts()
      } else {
        const result = await res.json()
        toast({
          title: t('payout_failed'),
          description: getErrorMessage(result, { statusCode: res.status }),
          variant: 'destructive',
        })
      }
    } catch {
      toast({ title: t('payout_failed'), variant: 'destructive' })
    } finally {
      setSubmitting(false)
    }
  }

  // Reverse charge picks the ruta 21 (EU) or ruta 22 (non-EU) basis pair, so
  // it cannot be booked while the region is still unanswered.
  const regionUnanswered = reverseCharge && sellerCountry === 'abroad'

  const stepOneValid =
    description.trim().length > 0 && parsedAmount > 0 && parsedVat < parsedAmount

  return (
    <div className="space-y-8">
      <PageHeader
        title={t('title')}
        description={t('description')}
        action={
          canWrite ? (
            <Button size="toolbar" onClick={() => setCreating(true)}>
              <PlusIcon className="h-4 w-4" />
              {t('new_claim')}
            </Button>
          ) : (
            <Button size="toolbar" disabled title={t('viewer_disabled_tooltip')}>
              <LockClosedIcon className="h-4 w-4" />
              {t('new_claim')}
            </Button>
          )
        }
      />

      {outstandingByClaimant.length > 0 && (
        <div className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
          {outstandingByClaimant.map(({ key, claimant_name: name, total_sek: sum }) => (
            <button
              key={key}
              type="button"
              disabled={!canWrite}
              title={canWrite ? t('outstanding_select_hint') : undefined}
              onClick={() =>
                setSelected(
                  new Set(
                    claims
                      .filter((c) => c.awaits_payout && expenseClaimantKey(c) === key)
                      .map((c) => c.id),
                  ),
                )
              }
              className="text-left disabled:cursor-default"
            >
              <span className="text-muted-foreground">{t('outstanding_to', { name })}</span>{' '}
              <span className="font-medium tabular-nums">{formatCurrency(sum)}</span>
            </button>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        {/* The status filter is a toolbar chip-picker like the other list
            pages, not a form select. */}
        <ContextPicker
          value={statusFilter}
          onChange={(id) => setStatusFilter(id as typeof statusFilter)}
          ariaLabel={t('th_status')}
          triggerLabel={
            statusFilter === 'all' ? t('filter_all') : t(`status_${statusFilter}`)
          }
          items={[
            { id: 'all', label: t('filter_all') },
            { id: 'registered', label: t('status_registered') },
            { id: 'paid', label: t('status_paid') },
          ]}
        />
        {canWrite && selected.size > 0 && (
          <Button size="toolbar"
            variant="outline"
            disabled={!selectionValid}
            title={selectionValid ? undefined : t('payout_selection_invalid')}
            onClick={() => setPaying(true)}
          >
            {t('payout_action', { count: selected.size, total: formatCurrency(selectedTotal) })}
          </Button>
        )}
      </div>

      {/* A failed reload keeps the claims on screen, with one line above them. */}
      {loadError && !loading && claims.length > 0 && (
        <AttnLine action={{ label: tCommon('retry'), onClick: () => void load() }}>
          {tCommon('refresh_failed')}
        </AttnLine>
      )}

      {loading ? (
        <LateReveal>
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div key={i} className="flex h-11 items-center gap-8 border-b-hairline">
              <Skeleton className="h-3.5 w-20" />
              <Skeleton className="h-3.5 w-48" />
              <Skeleton className="hidden h-3.5 w-32 md:block" />
              <Skeleton className="h-3.5 w-16" />
              <Skeleton className="ml-auto h-3.5 w-20" />
            </div>
          ))}
        </LateReveal>
      ) : loadError && claims.length === 0 ? (
        <LoadError title={t('load_failed')} onRetry={() => void load()} />
      ) : visibleClaims.length === 0 && claims.length > 0 ? (
        <p className="py-3 text-[13px] text-muted-foreground">{t('no_claims_in_filter')}</p>
      ) : visibleClaims.length === 0 ? (
        <EmptyState
          icon={ReceiptRefundIcon}
          title={t('empty_title')}
          description={t('empty_description')}
          actionLabel={canWrite ? t('new_claim') : undefined}
          onAction={canWrite ? () => setCreating(true) : undefined}
        />
      ) : (
        <div className="-mx-2 overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr>
              <th className={`${TH_CLASS} w-8`}>
                {canWrite && selectableIds.length > 0 ? (
                  <Checkbox
                    checked={allSelected ? true : someSelected ? 'indeterminate' : false}
                    onCheckedChange={() =>
                      setSelected(allSelected ? new Set() : new Set(selectableIds))
                    }
                    aria-label={t('select_all_claims')}
                  />
                ) : null}
              </th>
              <th className={TH_CLASS}>{t('th_date')}</th>
              <th className={TH_CLASS}>{t('th_description')}</th>
              <th className={`${TH_CLASS} hidden md:table-cell`}>{t('th_claimant')}</th>
              <th className={`${TH_CLASS} hidden lg:table-cell`}>{t('th_receipt')}</th>
              <th className={TH_CLASS}>{t('th_status')}</th>
              <th className={`${TH_CLASS} text-right`}>{t('th_amount')}</th>
              <th className={TH_CLASS} />
            </tr>
          </thead>
          <tbody className="stagger-enter">
            {visibleClaims.map((c) => (
              <tr
                key={c.id}
                onClick={() => {
                  if (c.journal_entry_id) router.push(`/bookkeeping/${c.journal_entry_id}`)
                }}
                className={`group transition-colors duration-150 hover:bg-secondary/35${c.journal_entry_id ? ' cursor-pointer' : ''}`}
              >
                <td
                  className={`${TD_CLASS} w-8`}
                  onClick={(e) => e.stopPropagation()}
                >
                  {c.awaits_payout && canWrite ? (
                    <Checkbox
                      checked={selected.has(c.id)}
                      onCheckedChange={() => toggleSelected(c.id)}
                      aria-label={t('select_claim')}
                    />
                  ) : null}
                </td>
                <td className={`${TD_CLASS} tabular-nums`}>{formatDate(c.expense_date)}</td>
                <td className={TD_CLASS}>
                  {c.journal_entry_id ? (
                    <Link
                      href={`/bookkeeping/${c.journal_entry_id}`}
                      className="hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {c.description}
                    </Link>
                  ) : (
                    c.description
                  )}
                </td>
                <td className={`${TD_CLASS} hidden md:table-cell`}>{c.claimant_name}</td>
                {/* A receipt is the normal state and says nothing; only a
                    missing one is marked. */}
                <td className={`${TD_CLASS} hidden lg:table-cell`}>
                  {!c.document && <span className="text-attn">{t('receipt_missing')}</span>}
                </td>
                <td className={TD_CLASS}>
                  {/* Chips mark exceptions (convention 5): registered and
                      paid are both normal states, so both read as muted text.
                      A claim on a salary run is repaid with that salary: the
                      status names the payment day and opens the run. */}
                  {c.salary_run ? (
                    <Link
                      href={`/salary/runs/${c.salary_run.salary_run_id}`}
                      className={`${QUIET_LINK_CLASS} whitespace-nowrap tabular-nums`}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {t('status_on_salary_run', { date: formatDate(c.salary_run.payment_date) })}
                    </Link>
                  ) : (
                    <span className="text-xs text-muted-foreground">{t(`status_${c.status}`)}</span>
                  )}
                  {c.batch && (
                    <span className="ml-2 text-xs text-muted-foreground tabular-nums">
                      {formatDate(c.batch.payout_date)}
                    </span>
                  )}
                </td>
                {/* One-line rows (convention 4): the original-currency amount
                    sits inline after the SEK amount instead of a second line. */}
                <td className={`${TD_CLASS} whitespace-nowrap text-right tabular-nums`}>
                  {formatRowAmount(c.amount_sek)}
                  {c.currency !== 'SEK' && c.amount_in_currency != null && (
                    <span className="ml-1.5 text-xs text-muted-foreground">
                      {formatRowAmount(c.amount_in_currency, c.currency)}
                    </span>
                  )}
                </td>
                <td className={`${TD_CLASS} w-16 text-right`} onClick={(e) => e.stopPropagation()}>
                  {c.status === 'registered' && canWrite && (
                    <button
                      type="button"
                      onClick={() => setDeleting(c)}
                      className={`${QUIET_LINK_CLASS} ${HOVER_REVEAL_CLASS}`}
                    >
                      {t('row_delete')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}

      {/* Booked payouts: each row is one bank transfer (skuld -> likvidkonto),
          so the list doubles as the transfer checklist after booking. */}
      {payoutBatches.length > 0 && (
        <div className="space-y-2 pt-4">
          <h2 className="text-sm font-medium text-muted-foreground">{t('payouts_heading')}</h2>
          <div className="-mx-2 overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                <th className={TH_CLASS}>{t('th_date')}</th>
                <th className={TH_CLASS}>{t('th_claimant')}</th>
                <th className={`${TH_CLASS} hidden sm:table-cell`}>{t('payout_cash_account')}</th>
                <th className={`${TH_CLASS} text-right`}>{t('th_amount')}</th>
                <th className={TH_CLASS} />
              </tr>
            </thead>
            <tbody>
              {payoutBatches.map((b) => (
                <tr key={b.id}>
                  <td className={`${TD_CLASS} tabular-nums`}>{formatDate(b.payout_date)}</td>
                  <td className={TD_CLASS}>{b.claimant_name}</td>
                  <td className={`${TD_CLASS} hidden tabular-nums sm:table-cell`}>{b.cash_account}</td>
                  <td className={`${TD_CLASS} text-right font-medium tabular-nums`}>
                    {formatRowAmount(b.total_sek)}
                  </td>
                  <td className={`${TD_CLASS} text-right`}>
                    {b.journal_entry_id && (
                      <Link
                        href={`/bookkeeping/${b.journal_entry_id}`}
                        className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                      >
                        {t('payout_view_entry')}
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {/* Create dialog: step 1 receipt + details, step 2 verifikat review. */}
      <Dialog open={creating} onOpenChange={(open) => !open && !submitting && resetCreate()}>
        {/* No max height of its own: DialogContent's dvh-based one keeps the
            footer above Safari's toolbar on a phone, where a vh one does not. */}
        <DialogContent
          className={
            receiptDoc && showReceipt
              ? 'flex max-w-[min(72rem,calc(100vw-var(--agent-sheet-w,0px)))] flex-col overflow-y-hidden'
              : 'sm:max-w-xl'
          }
        >
          <DialogHeader className="shrink-0">
            {/* Convention 7: how the claim is booked lives behind the "?". */}
            <div className="flex items-center gap-2">
              <DialogTitle>
                {t('new_claim')}
                <span className="ml-3 text-sm font-normal text-muted-foreground">
                  {step === 1 ? t('step_details') : t('step_booking')}
                </span>
              </DialogTitle>
              <HelpPopover className="shrink-0">{t('new_claim_help')}</HelpPopover>
            </div>
            {step === 1 ? (
              <DialogDescription className="sr-only">{t('new_claim_help')}</DialogDescription>
            ) : (
              <DialogDescription>{t('step_booking_help')}</DialogDescription>
            )}
          </DialogHeader>

          {receiptDoc && (
            <div className="flex shrink-0 justify-end">
              <Button type="button" variant="ghost" onClick={() => setShowReceipt((v) => !v)}>
                <DocumentTextIcon className="h-3.5 w-3.5" />
                {showReceipt ? t('hide_receipt') : t('show_receipt')}
              </Button>
            </div>
          )}

          <div
            className={
              receiptDoc && showReceipt
                ? 'grid min-h-0 flex-1 grid-cols-1 gap-6 overflow-y-auto lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]'
                : undefined
            }
          >
            {receiptDoc && showReceipt && (
              <div className="flex h-[40vh] flex-col lg:sticky lg:top-0 lg:h-[58vh] lg:self-start">
                <DocumentViewerPane
                  documentId={receiptDoc.id}
                  fileName={receiptDoc.fileName}
                  className="min-h-0 flex-1"
                />
              </div>
            )}
            <div className="min-w-0">
          {step === 1 ? (
            <div className="space-y-4">
              {/* Receipt drop zone with AI extraction */}
              <div className="space-y-2">
                <Label>{t('form_receipt_upload')}</Label>
                {upload.phase === 'idle' && inboxChoice !== NO_RECEIPT_VALUE ? (
                  // A receipt picked from the inbox: one line, like an upload.
                  <div className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm bg-control shadow-raised">
                    <DocumentTextIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">
                      {inboxOptions.find((i) => i.id === inboxChoice)?.label ?? inboxChoice}
                    </span>
                    <span className="text-xs text-muted-foreground">{t('form_receipt')}</span>
                    <button
                      type="button"
                      aria-label={t('form_receipt_none')}
                      onClick={() => setInboxChoice(NO_RECEIPT_VALUE)}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <XMarkIcon className="h-4 w-4" />
                    </button>
                  </div>
                ) : upload.phase === 'idle' || upload.phase === 'error' ? (
                  <>
                    {/* The zone opens the file chooser on a click anywhere
                        but the inbox link, which is its own button inside. */}
                    <div
                      onClick={(e) => {
                        if (e.target === e.currentTarget) fileInputRef.current?.click()
                      }}
                      onDragOver={(e) => {
                        e.preventDefault()
                        setDragOver(true)
                      }}
                      onDragLeave={() => setDragOver(false)}
                      onDrop={(e) => {
                        e.preventDefault()
                        setDragOver(false)
                        onFileChosen(e.dataTransfer.files)
                      }}
                      className={`flex w-full cursor-pointer flex-wrap items-center justify-center gap-x-2 gap-y-1 rounded-lg border border-dashed px-4 py-6 text-sm text-muted-foreground transition-colors duration-150 hover:border-foreground/40 ${
                        dragOver ? 'border-foreground/60 text-foreground' : 'border-border'
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        className="inline-flex items-center gap-2 transition-colors duration-150 hover:text-foreground"
                      >
                        <ArrowUpTrayIcon className="h-4 w-4" />
                        {t('dropzone_hint')}
                        {receiptRoute === 'inbox' && (
                          <span className="inline-flex items-center gap-1 text-xs">
                            <SparklesIcon className="h-3 w-3" />
                            {t('dropzone_ai_hint')}
                          </span>
                        )}
                      </button>
                      {inboxOptions.length > 0 && (
                        <button
                          type="button"
                          onClick={() => setShowInboxPicker(true)}
                          className="underline underline-offset-2 transition-colors duration-150 hover:text-foreground"
                        >
                          {t('dropzone_pick_from_inbox')}
                        </button>
                      )}
                    </div>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept={INBOX_UPLOAD_ACCEPT}
                      className="hidden"
                      onChange={(e) => onFileChosen(e.target.files)}
                    />
                    {upload.phase === 'error' && (
                      <p className="text-xs text-destructive">{upload.message}</p>
                    )}
                  </>
                ) : (
                  <div className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm bg-control shadow-raised">
                    {upload.phase === 'done' && receiptRoute !== 'inbox' ? (
                      <DocumentTextIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                    ) : upload.phase === 'done' ? (
                      <SparklesIcon className="h-4 w-4 shrink-0" />
                    ) : (
                      <SpinnerIcon className="h-4 w-4 shrink-0 animate-spin" />
                    )}
                    <span className="min-w-0 flex-1 truncate">{upload.fileName}</span>
                    <span className="text-xs text-muted-foreground">
                      {upload.phase === 'uploading' && t('upload_uploading')}
                      {upload.phase === 'extracting' && t('upload_extracting')}
                      {upload.phase === 'done' &&
                        (upload.extracted
                          ? t('upload_extracted')
                          : receiptRoute === 'inbox'
                            ? t('upload_no_extraction')
                            : t('upload_uploaded'))}
                    </span>
                    <button
                      type="button"
                      aria-label={t('upload_remove')}
                      onClick={() => {
                        pollAbort.current.cancelled = true
                        setUpload({ phase: 'idle' })
                      }}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <XMarkIcon className="h-4 w-4" />
                    </button>
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="ec_description">{t('form_description')}</Label>
                <Input
                  id="ec_description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder={t('form_description_placeholder')}
                />
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="ec_date">{t('form_date')}</Label>
                  <Input
                    id="ec_date"
                    type="date"
                    value={expenseDate}
                    onChange={(e) => setExpenseDate(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="ec_claimant">{t('form_claimant')}</Label>
                  <Select value={claimant} onValueChange={setClaimant}>
                    <SelectTrigger id="ec_claimant">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={OWNER_VALUE}>{t('form_claimant_owner', { account: ownerLiability })}</SelectItem>
                      {employees.map((e) => (
                        <SelectItem key={e.id} value={e.id}>
                          {e.first_name} {e.last_name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {claimant === OWNER_VALUE && (
                <div className="space-y-2">
                  <Label htmlFor="ec_owner_name">{t('form_owner_name')}</Label>
                  <Input
                    id="ec_owner_name"
                    value={ownerName}
                    onChange={(e) => setOwnerName(e.target.value)}
                    placeholder={t('owner_fallback_name')}
                  />
                </div>
              )}

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div className="space-y-2">
                  <Label htmlFor="ec_amount">{t('form_amount')}</Label>
                  <Input
                    id="ec_amount"
                    type="number"
                    step="0.01"
                    min="0"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="ec_vat">{t('form_vat')}</Label>
                  <Input
                    id="ec_vat"
                    type="number"
                    step="0.01"
                    min="0"
                    value={vatAmount}
                    onChange={(e) => setVatAmount(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="ec_currency">{t('form_currency')}</Label>
                  <Select value={currency} onValueChange={setCurrency}>
                    <SelectTrigger id="ec_currency">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CURRENCIES.map((c) => (
                        <SelectItem key={c} value={c}>
                          {c}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              {currency !== 'SEK' && (
                <p className="text-xs text-muted-foreground">{t('form_fx_hint')}</p>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              {/* Reached by Nästa without a receipt: say it once, here. The
                  claim may still be registered; the BFL reason is behind
                  the "?". */}
              {receiptMissing && (
                <AttnLine
                  trailing={
                    <HelpPopover className="ml-2 align-[-3px]">{t('form_receipt_warning')}</HelpPopover>
                  }
                >
                  {t('form_receipt_missing')}
                </AttnLine>
              )}
              {/* Step 2: VAT mode + templates + an editable verifikat grid.
                  The liability row is locked: the payout flow reimburses
                  exactly the claim gross from that account. */}
              {bookingMode === 'choose' ? (
                <div className="space-y-3">
                  <Input
                    placeholder={t('template_search_placeholder')}
                    value={templateSearch}
                    onChange={(e) => setTemplateSearch(e.target.value)}
                  />
                  <button
                    type="button"
                    className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-secondary/35 bg-control shadow-raised"
                    onClick={chooseManual}
                  >
                    <PencilSquareIcon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="flex-1">
                      <span className="block text-sm font-medium">{t('book_manually')}</span>
                      <span className="block text-xs text-muted-foreground">{t('book_manually_help')}</span>
                    </span>
                    <ChevronRightIcon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  </button>
                  <div className="max-h-[340px] space-y-3 overflow-y-auto">
                    {!templateSearch.trim() && (templateSections.recommended.length > 0 || aiPending) && (
                      <div className="space-y-1">
                        <div className="flex items-center gap-2 px-3 pt-1 text-xs font-medium text-muted-foreground">
                          {t('templates_recommended')}
                          {templateSections.recommendedSource === 'ai' && !aiPending && (
                            <span className="flex items-center gap-1">
                              <SparklesIcon className="h-3 w-3" aria-hidden="true" />
                              {t('templates_ai_badge')}
                            </span>
                          )}
                          {aiPending && <SpinnerIcon className="h-3 w-3 animate-spin" aria-hidden="true" />}
                        </div>
                        {aiPending && templateSections.recommended.length === 0 ? (
                          <p className="px-3 py-2.5 text-sm text-muted-foreground">{t('templates_ai_loading')}</p>
                        ) : (
                          templateSections.recommended.map((tpl) => (
                            <button
                              key={tpl.id}
                              type="button"
                              className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-secondary/35"
                              onClick={() => chooseTemplate(tpl)}
                            >
                              <span className="flex-1">
                                <span className="block text-sm font-medium">{tpl.name}</span>
                                {tpl.description && (
                                  <span className="block text-xs leading-snug text-muted-foreground">{tpl.description}</span>
                                )}
                              </span>
                              <ChevronRightIcon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                            </button>
                          ))
                        )}
                      </div>
                    )}
                    {([
                      ['templates_recent', templateSections.recent],
                      ['templates_all', templateSections.all],
                    ] as const).map(([labelKey, list]) =>
                      list.length === 0 ? null : (
                        <div key={labelKey} className="space-y-1">
                          {(templateSections.recommended.length > 0 || templateSections.recent.length > 0 || aiPending) && (
                            <p className="px-3 pt-1 text-xs font-medium text-muted-foreground">
                              {t(labelKey)}
                            </p>
                          )}
                          {list.map((tpl) => (
                            <button
                              key={tpl.id}
                              type="button"
                              className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-secondary/35"
                              onClick={() => chooseTemplate(tpl)}
                            >
                              <span className="flex-1">
                                <span className="block text-sm font-medium">{tpl.name}</span>
                                {tpl.description && (
                                  <span className="block text-xs leading-snug text-muted-foreground">{tpl.description}</span>
                                )}
                              </span>
                              <ChevronRightIcon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                            </button>
                          ))}
                        </div>
                      ),
                    )}
                    {!aiPending &&
                      templateSections.recommended.length === 0 &&
                      templateSections.recent.length === 0 &&
                      templateSections.all.length === 0 && (
                        <p className="px-3 py-4 text-sm text-muted-foreground">{t('no_templates_found')}</p>
                      )}
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-lg bg-secondary/40 px-3 py-2.5 text-left"
                    onClick={() => setBookingMode('choose')}
                  >
                    <ChevronLeftIcon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="flex-1">
                      <span className="block text-sm font-medium">
                        {appliedTemplate ? appliedTemplate.name : t('book_manually')}
                      </span>
                      {appliedTemplate?.description && (
                        <span className="block text-xs leading-snug text-muted-foreground">
                          {appliedTemplate.description}
                        </span>
                      )}
                    </span>
                  </button>
                  {bookingRows === null && (
                    <div className="grid gap-4 sm:grid-cols-2">
                      <div className="space-y-2">
                        <Label>{t('form_seller_country')}</Label>
                        {/* Two-step (Bokio-style): Sverige/utomlands here; the
                            EU vs non-EU split only matters for reverse charge
                            (ruta 21 vs 22) and is asked when RC is opted in. */}
                        <Select
                          value={sellerCountry === 'se' ? 'se' : 'abroad'}
                          onValueChange={(v) => applyCountry(v === 'se' ? 'se' : 'abroad')}
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="se">{t('seller_country_se')}</SelectItem>
                            <SelectItem value="abroad">{t('seller_country_abroad')}</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      {!appliedTemplate && (
                        <div className="space-y-2">
                          <Label>{t('form_expense_account')}</Label>
                          <AccountCombobox
                            value={expenseAccount}
                            accounts={accounts}
                            selectedName={accountName(expenseAccount)}
                            onChange={(v) => {
                              setExpenseAccount(v)
                              setBookingRows(null)
                            }}
                          />
                        </div>
                      )}
                    </div>
                  )}
                  {bookingRows === null && sellerCountry !== 'se' && (
                    <div className="space-y-2">
                      <label className="flex items-center gap-2 text-sm">
                        <Checkbox
                          checked={reverseCharge}
                          onCheckedChange={(v) => {
                            setReverseCharge(v === true)
                            setBookingRows(null)
                          }}
                        />
                        {t('rc_toggle')}
                      </label>
                      {reverseCharge && (
                        <div className="max-w-xs space-y-2">
                          <Label>{t('rc_region_label')}</Label>
                          <Select
                            value={sellerCountry === 'abroad' ? undefined : sellerCountry}
                            onValueChange={(v) => {
                              setSellerCountry(v as SellerCountry)
                              setBookingRows(null)
                            }}
                          >
                            <SelectTrigger>
                              <SelectValue placeholder={t('rc_region_placeholder')} />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="eu">{t('seller_country_eu')}</SelectItem>
                              <SelectItem value="noneu">{t('seller_country_noneu')}</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      )}
                      <p className="text-xs text-muted-foreground">
                        {!reverseCharge
                          ? t('seller_country_gross_hint')
                          : sellerCountry === 'eu'
                            ? t('seller_country_eu_hint')
                            : sellerCountry === 'noneu'
                              ? t('seller_country_noneu_hint')
                              : t('rc_region_required')}
                      </p>
                    </div>
                  )}
                  {/* Kostnadsställe/projekt for the claim: tags the cost rows,
                      never the VAT or liability legs. */}
                  {dimensionsEnabled && (
                    <div className="max-w-md">
                      <LineDimensionFields dimensions={claimDims} onChange={setClaimDimension} />
                    </div>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setShowSaveTemplate(true)}
                      disabled={templateSeedLines.length < 2}
                    >
                      {t('save_as_template')}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => setShowRowEditor((v) => !v)}
                    >
                      {showRowEditor ? t('hide_row_editor') : t('edit_rows')}
                    </Button>
                  </div>
              <div className="overflow-x-auto">
              <table className="w-full min-w-[420px] border-collapse text-[13px]">
                <thead>
                  <tr>
                    <th className={TH_CLASS}>{t('preview_account')}</th>
                    <th className={`${TH_CLASS} w-[110px] text-right`}>{t('preview_debit')}</th>
                    <th className={`${TH_CLASS} w-[110px] text-right`}>{t('preview_credit')}</th>
                    <th className={`${TH_CLASS} w-[36px]`} aria-hidden="true"></th>
                  </tr>
                </thead>
                <tbody>
                  {editorRows.map((row) =>
                    showRowEditor ? (
                      <tr key={row.key}>
                        <td className={`${TD_CLASS} pr-2`}>
                          <AccountCombobox
                            value={row.account}
                            accounts={accounts}
                            selectedName={accountName(row.account)}
                            onChange={(v) => editRow(row.key, { account: v })}
                          />
                        </td>
                        <td className={`${TD_CLASS} text-right`}>
                          <Input
                            type="number"
                            step="0.01"
                            min="0"
                            className="text-right tabular-nums"
                            value={row.debit}
                            onChange={(e) => editRow(row.key, { debit: e.target.value, credit: '' })}
                          />
                        </td>
                        <td className={`${TD_CLASS} text-right`}>
                          <Input
                            type="number"
                            step="0.01"
                            min="0"
                            className="text-right tabular-nums"
                            value={row.credit}
                            onChange={(e) => editRow(row.key, { credit: e.target.value, debit: '' })}
                          />
                        </td>
                        <td className={TD_CLASS}>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label={t('remove_row')}
                            onClick={() => removeRow(row.key)}
                          >
                            <XMarkIcon className="h-3.5 w-3.5" />
                          </Button>
                        </td>
                      </tr>
                    ) : (
                      <tr key={row.key}>
                        <td className={TD_CLASS}>
                          {row.account}{' '}
                          <span className="text-muted-foreground">{accountName(row.account)}</span>
                        </td>
                        <td className={`${TD_CLASS} text-right tabular-nums`}>
                          {row.debit && `${row.debit} ${currency}`}
                        </td>
                        <td className={`${TD_CLASS} text-right tabular-nums`}>
                          {row.credit && `${row.credit} ${currency}`}
                        </td>
                        <td className={TD_CLASS} />
                      </tr>
                    ),
                  )}
                  <tr>
                    <td className={TD_CLASS}>
                      <LockClosedIcon
                        className="mr-1.5 inline h-3.5 w-3.5 align-[-2px] text-muted-foreground"
                        aria-hidden="true"
                      />
                      {liabilityAccount}{' '}
                      <span className="text-muted-foreground">{accountName(liabilityAccount)}</span>
                    </td>
                    <td className={`${TD_CLASS} text-right`} />
                    <td className={`${TD_CLASS} text-right tabular-nums`}>
                      {formatAmount(parsedAmount)} {currency}
                    </td>
                    <td className={TD_CLASS} />
                  </tr>
                  <tr>
                    <td className={`${TD_CLASS} font-medium`}>
                      {showRowEditor && (
                        <Button type="button" variant="ghost" className="-ml-2" onClick={addRow}>
                          <PlusIcon className="h-3.5 w-3.5" />
                          {t('add_row')}
                        </Button>
                      )}
                    </td>
                    <td className={`${TD_CLASS} text-right font-medium tabular-nums`}>
                      {formatAmount(totalDebit)}
                    </td>
                    <td className={`${TD_CLASS} text-right font-medium tabular-nums`}>
                      {formatAmount(totalCredit)}
                    </td>
                    <td className={TD_CLASS}>
                      {/* A balanced verifikat is the normal state: only the
                          exception gets a chip (convention 5). */}
                      {!(bookingBalanced && bookingRowsValid) && (
                        <Badge variant="outline" className="font-normal text-attn">
                          {t('unbalanced')}
                        </Badge>
                      )}
                    </td>
                  </tr>
                </tbody>
              </table>
              </div>
              <p className="text-xs text-muted-foreground">
                {t('preview_summary', {
                  name: claimantDisplay,
                  date: formatDate(expenseDate),
                })}
                {currency !== 'SEK' && <> {t('preview_fx_note')}</>}
              </p>
                </div>
              )}
            </div>
          )}
            </div>
          </div>

          <DialogFooter className="shrink-0">
            <Button type="button" variant="outline" onClick={resetCreate} disabled={submitting}>
              {t('form_cancel')}
            </Button>
            {step === 2 && (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  if (bookingMode === 'book') setBookingMode('choose')
                  else setStep(1)
                }}
                disabled={submitting}
              >
                {t('form_back')}
              </Button>
            )}
            {step === 1 ? (
              <Button
                type="button"
                onClick={() => setStep(2)}
                disabled={!stepOneValid || upload.phase === 'uploading'}
              >
                {t('form_next')}
              </Button>
            ) : (
              <Button
                type="button"
                onClick={handleCreate}
                loading={submitting}
                disabled={
                  upload.phase === 'uploading' ||
                  bookingMode !== 'book' ||
                  regionUnanswered ||
                  !bookingBalanced ||
                  !bookingRowsValid
                }
              >
                {t('form_register')}
              </Button>
            )}
          </DialogFooter>

          <InboxDocumentPicker
            open={showInboxPicker}
            onClose={() => setShowInboxPicker(false)}
            onSelect={(doc: AvailableInboxDoc) => {
              setShowInboxPicker(false)
              setInboxChoice(doc.inbox_item_id)
              const picked = inboxOptions.find((i) => i.id === doc.inbox_item_id)
              // An explicit pick wins: overwrite the previous receipt's prefill.
              if (picked?.extracted) applyExtraction(picked.extracted, { force: true })
            }}
          />

          {showSaveTemplate && (
            <Dialog open onOpenChange={(open) => !open && setShowSaveTemplate(false)}>
              <DialogContent size="form">
                <DialogHeader>
                  <DialogTitle>{t('save_as_template')}</DialogTitle>
                </DialogHeader>
                <TemplateForm
                  mode="create"
                  entityLabels={{
                    all: tTpl('entity_all'),
                    enskild_firma: tTpl('entity_enskild_firma'),
                    aktiebolag: tTpl('entity_aktiebolag'),
                  }}
                  initialTemplate={{
                    id: '',
                    company_id: null,
                    team_id: null,
                    created_by: null,
                    name: description.trim(),
                    description: '',
                    category: 'other',
                    entity_type: 'all',
                    lines: templateSeedLines,
                    is_system: false,
                    is_active: true,
                    created_at: '',
                    updated_at: '',
                  } satisfies BookingTemplateLibrary}
                  onSaved={() => setShowSaveTemplate(false)}
                />
              </DialogContent>
            </Dialog>
          )}
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <Dialog open={!!deleting} onOpenChange={(open) => !open && !submitting && setDeleting(null)}>
        <DialogContent size="confirm">
          <DialogHeader>
            <DialogTitle>{t('delete_title')}</DialogTitle>
            <DialogDescription>
              {deleting &&
                t('delete_help', {
                  description: deleting.description,
                  total: formatCurrency(deleting.amount_sek),
                })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDeleting(null)}
              disabled={submitting}
            >
              {t('form_cancel')}
            </Button>
            <Button type="button" variant="destructive" onClick={handleDelete} loading={submitting}>
              {t('delete_confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Payout dialog */}
      <Dialog open={paying} onOpenChange={(open) => !open && !submitting && setPaying(false)}>
        <DialogContent size="confirm">
          <DialogHeader>
            <DialogTitle>{t('payout_title')}</DialogTitle>
            <DialogDescription>
              {t('payout_help', {
                count: selectedClaims.length,
                name: selectedClaims[0]?.claimant_name ?? '',
                total: formatCurrency(selectedTotal),
              })}
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="po_date">{t('payout_date')}</Label>
              <Input
                id="po_date"
                type="date"
                value={payoutDate}
                onChange={(e) => setPayoutDate(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="po_account">{t('payout_account')}</Label>
              <Select value={cashAccount} onValueChange={setCashAccount}>
                <SelectTrigger id="po_account">
                  <SelectValue placeholder={t('payout_account_placeholder')} />
                </SelectTrigger>
                <SelectContent>
                  {cashAccounts.map((a) => (
                    <SelectItem key={a.account_number} value={a.account_number}>
                      {a.account_number} · {a.account_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setPaying(false)}
              disabled={submitting}
            >
              {t('form_cancel')}
            </Button>
            <Button type="button" onClick={handlePayout} disabled={!cashAccount} loading={submitting}>
              {t('payout_confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
