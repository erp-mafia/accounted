'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { Receipt, Lock, Loader2, Upload, Sparkles, X, Plus, ChevronRight, ChevronLeft, NotebookPen, FileText } from 'lucide-react'
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
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'
import { Checkbox } from '@/components/ui/checkbox'
import { TH_CLASS, TD_CLASS } from '@/components/ui/dry-table'
import AccountCombobox from '@/components/bookkeeping/AccountCombobox'
import InboxDocumentPicker, { type AvailableInboxDoc } from '@/components/bookkeeping/InboxDocumentPicker'
import DocumentViewerPane from '@/components/bookkeeping/DocumentViewerPane'
import { useAccounts, useBookingTemplates } from '@/lib/reference-data/hooks'
import type { BookingTemplateWithUsage } from '@/lib/reference-data/fetchers'
import { TemplateForm } from '@/components/settings/TemplateForm'
import { applyTemplate, deriveTemplateLinesFromBooking } from '@/lib/bookkeeping/template-library'
import { BOOKING_TEMPLATES, findMatchingTemplates } from '@/lib/bookkeeping/booking-templates'
import { roundOre, sumOre } from '@/lib/money'
import { ACCOUNT_NUMBER_RE } from '@/lib/invariants'
import { useToast } from '@/components/ui/use-toast'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { formatCurrency, formatDate } from '@/lib/utils'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import type { BookingTemplateLibrary } from '@/types'

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
  journal_entry_id: string | null
  document: { id: string; file_name: string | null } | null
  batch: { id: string; payout_date: string } | null
}

interface EmployeeOption {
  id: string
  first_name: string
  last_name: string
}

interface InboxOption {
  id: string
  document_id: string | null
  label: string
  extracted: ExtractedReceipt | null
}

interface ExtractedReceipt {
  totals?: { total?: number; vatAmount?: number } | null
  invoice?: { invoiceDate?: string | null; currency?: string | null } | null
  supplier?: { name?: string | null } | null
  lineItems?: Array<{ description?: string | null }> | null
}

const STATUS_VARIANT: Record<ExpenseClaim['status'], 'secondary' | 'success'> = {
  registered: 'secondary',
  paid: 'success',
}

const OWNER_VALUE = 'owner'
const NO_RECEIPT_VALUE = 'none'
type SellerCountry = 'se' | 'eu' | 'noneu'
interface BookingRow {
  key: number
  account: string
  debit: string
  credit: string
}
let bookingRowKey = 0
const nextRowKey = () => ++bookingRowKey

const CURRENCIES = ['SEK', 'EUR', 'USD', 'GBP', 'NOK', 'DKK'] as const
const UPLOAD_ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp,.heic'
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
      inboxItemId: string
      documentId: string | null
      extracted: ExtractedReceipt | null
    }
  | { phase: 'error'; message: string }

export default function ExpenseClaimsPage() {
  const t = useTranslations('expense_claims')
  const tTpl = useTranslations('settings_booking_templates')
  const { toast } = useToast()
  const { canWrite } = useCanWrite()
  const router = useRouter()
  const searchParams = useSearchParams()
  const appliedDeepLink = useRef(false)

  const [claims, setClaims] = useState<ExpenseClaim[]>([])
  const [employees, setEmployees] = useState<EmployeeOption[]>([])
  const { accounts } = useAccounts()
  const [inboxOptions, setInboxOptions] = useState<InboxOption[]>([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState<'all' | 'registered' | 'paid'>('all')
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const [creating, setCreating] = useState(false)
  const [step, setStep] = useState<1 | 2>(1)
  const [paying, setPaying] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [deleting, setDeleting] = useState<ExpenseClaim | null>(null)

  // Create form
  const [description, setDescription] = useState('')
  const [expenseDate, setExpenseDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [amount, setAmount] = useState('')
  const [vatAmount, setVatAmount] = useState('')
  const [currency, setCurrency] = useState('SEK')
  const [expenseAccount, setExpenseAccount] = useState('5410')
  // Step 2 booking editor (the Bokio model): one owner of the rows at a
  // time. Seller country + cost account generate them, OR an applied
  // template owns them, OR a manual edit freezes them into `bookingRows`.
  const [sellerCountry, setSellerCountry] = useState<SellerCountry>('se')
  const [bookingMode, setBookingMode] = useState<'choose' | 'book'>('choose')
  const { templates } = useBookingTemplates()
  const [templateSearch, setTemplateSearch] = useState('')
  const [appliedTemplate, setAppliedTemplate] = useState<{ name: string; description: string } | null>(null)
  const [bookingRows, setBookingRows] = useState<BookingRow[] | null>(null)
  const [showRowEditor, setShowRowEditor] = useState(false)
  const [showSaveTemplate, setShowSaveTemplate] = useState(false)
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
  const [payoutDate, setPayoutDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [cashAccount, setCashAccount] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/expense-claims')
      if (res.ok) {
        const { data } = await res.json()
        setClaims(data || [])
      }
    } finally {
      setLoading(false)
    }
  }, [])

  const loadInbox = useCallback(async () => {
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
          .filter(
            (i) => i.document_id && !i.created_journal_entry_id && !i.created_supplier_invoice_id,
          )
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
    }
  }, [])

  useEffect(() => {
    load()
    loadInbox()
    fetch('/api/salary/employees')
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => setEmployees(json?.data ?? []))
      .catch(() => setEmployees([]))
  }, [load, loadInbox])

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

  const outstandingByClaimant = useMemo(() => {
    const sums = new Map<string, number>()
    for (const c of claims) {
      if (c.status !== 'registered') continue
      sums.set(c.claimant_name, (sums.get(c.claimant_name) ?? 0) + c.amount_sek)
    }
    return [...sums.entries()].sort((a, b) => b[1] - a[1])
  }, [claims])

  const selectedClaims = useMemo(
    () => claims.filter((c) => selected.has(c.id)),
    [claims, selected],
  )
  const selectedTotal = selectedClaims.reduce((sum, c) => sum + c.amount_sek, 0)
  const selectionValid =
    selectedClaims.length > 0 &&
    new Set(selectedClaims.map((c) => c.employee_id ?? OWNER_VALUE)).size === 1 &&
    new Set(selectedClaims.map((c) => c.liability_account)).size === 1

  const liabilityAccount = claimant === OWNER_VALUE ? '2893' : '2820'
  const parsedAmount = parseFloat(amount) || 0
  const parsedVat = parseFloat(vatAmount) || 0
  const netAmount = Math.max(0, parsedAmount - parsedVat)

  // Seller country resolves the VAT mechanics (the Bokio model): Sweden
  // books the receipt VAT on 2641; EU / outside EU books the gross as
  // reverse-charge basis on the ruta-bearing account with the 2614/2645 pair.
  const generatedRows = useMemo<BookingRow[]>(() => {
    if (sellerCountry === 'se') {
      return [
        { key: nextRowKey(), account: expenseAccount, debit: netAmount.toFixed(2), credit: '' },
        ...(parsedVat > 0
          ? [{ key: nextRowKey(), account: '2641', debit: parsedVat.toFixed(2), credit: '' }]
          : []),
      ]
    }
    // The engine's house pattern (same as supplier invoices and the
    // transactions flow): the cost stays on the chosen cost account, the
    // fiktiv-moms pair books 2645/2614, and the basbelopp pair (45xx debet /
    // 4598 kredit) feeds ruta 21/22 while netting to zero in the P&L. When
    // the chosen account already IS a basis account the pair is skipped.
    const isBasisCost = /^4[45]\d{2}$/.test(expenseAccount)
    const basisAccount = isBasisCost
      ? expenseAccount
      : sellerCountry === 'eu'
        ? '4535'
        : '4531'
    const rcRate = /^45(36|32)/.test(basisAccount) ? 0.12 : /^45(37|33)/.test(basisAccount) ? 0.06 : 0.25
    const rc = roundOre(parsedAmount * rcRate)
    return [
      { key: nextRowKey(), account: expenseAccount, debit: parsedAmount.toFixed(2), credit: '' },
      ...(isBasisCost
        ? []
        : [
            { key: nextRowKey(), account: basisAccount, debit: parsedAmount.toFixed(2), credit: '' },
            { key: nextRowKey(), account: '4598', debit: '', credit: parsedAmount.toFixed(2) },
          ]),
      { key: nextRowKey(), account: '2645', debit: rc.toFixed(2), credit: '' },
      { key: nextRowKey(), account: '2614', debit: '', credit: rc.toFixed(2) },
    ]
  }, [sellerCountry, expenseAccount, netAmount, parsedAmount, parsedVat])

  const editorRows = bookingRows ?? generatedRows
  const rowSum = (side: 'debit' | 'credit') => sumOre(editorRows.map((r) => parseFloat(r[side]) || 0))
  const totalDebit = rowSum('debit')
  const totalCredit = roundOre(rowSum('credit') + parsedAmount)
  const bookingBalanced = Math.abs(totalDebit - totalCredit) <= 0.005
  const bookingRowsValid = editorRows.every((r) => {
    const d = parseFloat(r.debit) || 0
    const c = parseFloat(r.credit) || 0
    return ACCOUNT_NUMBER_RE.test(r.account) && (d > 0) !== (c > 0)
  })

  const EXCLUDED_TEMPLATE_CATEGORIES = ['salary', 'year_end', 'vat', 'tax_account', 'private_transfer']
  /** Expense-shaped library template: every business line is a debit and no
   *  2614/2645 legs: the country selector owns the reverse-charge variant. */
  const isExpenseLibraryTemplate = (tpl: BookingTemplateWithUsage) => {
    const business = tpl.lines.filter((l) => l.type === 'business')
    if (business.length === 0) return false
    if (!business.every((l) => l.side === 'debit')) return false
    if (tpl.lines.some((l) => l.account === '2614' || l.account === '2645')) return false
    return true
  }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
          { account_number: liabilityAccount, debit_amount: '', credit_amount: parsedAmount.toFixed(2), line_description: '' },
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
    setSellerCountry('se')
    setBookingMode('choose')
    setTemplateSearch('')
    setAppliedTemplate(null)
    setBookingRows(null)
    setShowRowEditor(false)
    setShowSaveTemplate(false)
    setStep(1)
    setCreating(false)
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
          force || prev === new Date().toISOString().slice(0, 10) ? date : prev,
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
    if (searchParams.get('new') !== '1') return
    const wanted = searchParams.get('inbox_item')
    if (wanted && inboxOptions.length === 0) return // wait for the inbox load
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
  }, [searchParams, inboxOptions, applyExtraction, router])

  const startUpload = useCallback(
    async (file: File) => {
      pollAbort.current = { cancelled: false }
      setUpload({ phase: 'uploading', fileName: file.name })
      try {
        const form = new FormData()
        form.append('file', file)
        const res = await fetch('/api/extensions/ext/invoice-inbox/upload', {
          method: 'POST',
          body: form,
        })
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
    [applyExtraction, t],
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
      if (uploaded) {
        body.inbox_item_id = uploaded.inboxItemId
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
          claim_ids: [...selected],
          payout_date: payoutDate,
          cash_account: cashAccount,
        }),
      })
      if (res.ok) {
        toast({ title: t('payout_created') })
        setSelected(new Set())
        setPaying(false)
        await load()
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

  const stepOneValid =
    description.trim().length > 0 &&
    parsedAmount > 0 &&
    parsedVat < parsedAmount &&
    (claimant !== OWNER_VALUE || true)

  return (
    <div className="space-y-8">
      <PageHeader
        title={t('title')}
        description={t('description')}
        action={
          canWrite ? (
            <Button onClick={() => setCreating(true)}>{t('new_claim')}</Button>
          ) : (
            <Button disabled title={t('viewer_disabled_tooltip')}>
              <Lock className="mr-2 h-4 w-4" />
              {t('new_claim')}
            </Button>
          )
        }
      />

      {outstandingByClaimant.length > 0 && (
        <div className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
          {outstandingByClaimant.map(([name, sum]) => (
            <div key={name}>
              <span className="text-muted-foreground">{t('outstanding_to', { name })}</span>{' '}
              <span className="font-medium tabular-nums">{formatCurrency(sum)}</span>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as typeof statusFilter)}>
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('filter_all')}</SelectItem>
            <SelectItem value="registered">{t('status_registered')}</SelectItem>
            <SelectItem value="paid">{t('status_paid')}</SelectItem>
          </SelectContent>
        </Select>
        {canWrite && selected.size > 0 && (
          <Button
            variant="outline"
            disabled={!selectionValid}
            title={selectionValid ? undefined : t('payout_selection_invalid')}
            onClick={() => setPaying(true)}
          >
            {t('payout_action', { count: selected.size, total: formatCurrency(selectedTotal) })}
          </Button>
        )}
      </div>

      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      ) : visibleClaims.length === 0 ? (
        <EmptyState
          icon={Receipt}
          title={t('empty_title')}
          description={t('empty_description')}
          actionLabel={canWrite ? t('new_claim') : undefined}
          onAction={canWrite ? () => setCreating(true) : undefined}
        />
      ) : (
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr>
              <th className={TH_CLASS} />
              <th className={TH_CLASS}>{t('th_date')}</th>
              <th className={TH_CLASS}>{t('th_description')}</th>
              <th className={TH_CLASS}>{t('th_claimant')}</th>
              <th className={TH_CLASS}>{t('th_receipt')}</th>
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
                className={c.journal_entry_id ? 'cursor-pointer hover:bg-muted/40' : undefined}
              >
                <td
                  className={`${TD_CLASS} w-8`}
                  onClick={(e) => e.stopPropagation()}
                >
                  {c.status === 'registered' && canWrite ? (
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
                  <span className="ml-2 text-muted-foreground">{c.expense_account}</span>
                </td>
                <td className={TD_CLASS}>{c.claimant_name}</td>
                <td className={TD_CLASS}>
                  {c.document ? (
                    <span className="text-muted-foreground">
                      {c.document.file_name ?? t('receipt_attached')}
                    </span>
                  ) : (
                    <span className="text-attn">{t('receipt_missing')}</span>
                  )}
                </td>
                <td className={TD_CLASS}>
                  <Badge variant={STATUS_VARIANT[c.status]} className="font-normal">
                    {t(`status_${c.status}`)}
                  </Badge>
                  {c.batch && (
                    <span className="ml-2 text-xs text-muted-foreground tabular-nums">
                      {formatDate(c.batch.payout_date)}
                    </span>
                  )}
                </td>
                <td className={`${TD_CLASS} text-right tabular-nums`}>
                  {formatCurrency(c.amount_sek)}
                  {c.currency !== 'SEK' && c.amount_in_currency != null && (
                    <div className="text-xs text-muted-foreground">
                      ({c.amount_in_currency.toFixed(2)} {c.currency})
                    </div>
                  )}
                </td>
                <td className={`${TD_CLASS} w-16 text-right`} onClick={(e) => e.stopPropagation()}>
                  {c.status === 'registered' && canWrite && (
                    <button
                      type="button"
                      onClick={() => setDeleting(c)}
                      className="text-xs text-muted-foreground underline decoration-border underline-offset-4 transition-colors duration-150 hover:text-foreground hover:decoration-foreground"
                    >
                      {t('row_delete')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Create dialog: step 1 receipt + details, step 2 verifikat review. */}
      <Dialog open={creating} onOpenChange={(open) => !open && !submitting && resetCreate()}>
        <DialogContent
          className={
            receiptDoc && showReceipt
              ? 'max-w-[min(72rem,calc(100vw-var(--agent-sheet-w,0px)))] max-h-[90vh] overflow-y-auto'
              : 'sm:max-w-xl'
          }
        >
          <DialogHeader>
            <DialogTitle>
              {t('new_claim')}
              <span className="ml-3 text-sm font-normal text-muted-foreground">
                {step === 1 ? t('step_details') : t('step_booking')}
              </span>
            </DialogTitle>
            <DialogDescription>
              {step === 1 ? t('new_claim_help') : t('step_booking_help')}
            </DialogDescription>
          </DialogHeader>

          {receiptDoc && (
            <div className="flex justify-end">
              <Button type="button" variant="ghost" size="sm" onClick={() => setShowReceipt((v) => !v)}>
                <FileText className="mr-1.5 h-3.5 w-3.5" />
                {showReceipt ? t('hide_receipt') : t('show_receipt')}
              </Button>
            </div>
          )}

          <div
            className={
              receiptDoc && showReceipt
                ? 'grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]'
                : undefined
            }
          >
            {receiptDoc && showReceipt && (
              <div className="flex h-[45vh] flex-col lg:sticky lg:top-0 lg:h-[72vh] lg:self-start">
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
                {upload.phase === 'idle' || upload.phase === 'error' ? (
                  <>
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
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
                      className={`flex w-full items-center justify-center gap-2 rounded-lg border border-dashed px-4 py-6 text-sm text-muted-foreground transition-colors duration-150 hover:border-foreground/40 hover:text-foreground ${
                        dragOver ? 'border-foreground/60 text-foreground' : 'border-border'
                      }`}
                    >
                      <Upload className="h-4 w-4" />
                      {t('dropzone_hint')}
                      <span className="inline-flex items-center gap-1 text-xs">
                        <Sparkles className="h-3 w-3" />
                        {t('dropzone_ai_hint')}
                      </span>
                    </button>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept={UPLOAD_ACCEPT}
                      className="hidden"
                      onChange={(e) => onFileChosen(e.target.files)}
                    />
                    {upload.phase === 'error' && (
                      <p className="text-xs text-destructive">{upload.message}</p>
                    )}
                  </>
                ) : (
                  <div className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm">
                    {upload.phase === 'done' ? (
                      <Sparkles className="h-4 w-4 shrink-0" />
                    ) : (
                      <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                    )}
                    <span className="min-w-0 flex-1 truncate">{upload.fileName}</span>
                    <span className="text-xs text-muted-foreground">
                      {upload.phase === 'uploading' && t('upload_uploading')}
                      {upload.phase === 'extracting' && t('upload_extracting')}
                      {upload.phase === 'done' &&
                        (upload.extracted ? t('upload_extracted') : t('upload_no_extraction'))}
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
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                )}
              </div>

              {upload.phase === 'idle' && inboxOptions.length > 0 && (
                <div className="space-y-2">
                  <Label>{t('form_receipt')}</Label>
                  <div className="flex items-center gap-2">
                    {inboxChoice !== NO_RECEIPT_VALUE ? (
                      <Badge variant="secondary" className="gap-1.5 py-1 pl-2 pr-1 font-normal">
                        <span className="max-w-[260px] truncate">
                          {inboxOptions.find((i) => i.id === inboxChoice)?.label ?? inboxChoice}
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-5 w-5"
                          aria-label={t('form_receipt_none')}
                          onClick={() => setInboxChoice(NO_RECEIPT_VALUE)}
                        >
                          <X className="h-3 w-3" />
                        </Button>
                      </Badge>
                    ) : (
                      <span className="text-sm text-muted-foreground">{t('form_receipt_none')}</span>
                    )}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setShowInboxPicker(true)}
                    >
                      {t('form_pick_from_inbox')}
                    </Button>
                  </div>
                </div>
              )}

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
                      <SelectItem value={OWNER_VALUE}>{t('form_claimant_owner')}</SelectItem>
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
              {upload.phase === 'idle' && inboxChoice === NO_RECEIPT_VALUE && (
                <p className="text-xs text-attn">{t('form_receipt_warning')}</p>
              )}
            </div>
          ) : (
            <div className="space-y-4">
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
                    className="flex w-full items-center gap-3 rounded-lg border border-border px-3 py-2.5 text-left transition-colors hover:bg-secondary/35"
                    onClick={chooseManual}
                  >
                    <NotebookPen className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="flex-1">
                      <span className="block text-sm font-medium">{t('book_manually')}</span>
                      <span className="block text-xs text-muted-foreground">{t('book_manually_help')}</span>
                    </span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  </button>
                  <div className="max-h-[340px] space-y-3 overflow-y-auto">
                    {!templateSearch.trim() && (templateSections.recommended.length > 0 || aiPending) && (
                      <div className="space-y-1">
                        <p className="flex items-center gap-2 px-3 pt-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                          {t('templates_recommended')}
                          {templateSections.recommendedSource === 'ai' && !aiPending && (
                            <span className="flex items-center gap-1">
                              <Sparkles className="h-3 w-3" aria-hidden="true" />
                              {t('templates_ai_badge')}
                            </span>
                          )}
                          {aiPending && <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />}
                        </p>
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
                              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
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
                            <p className="px-3 pt-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
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
                              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
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
                    <ChevronLeft className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
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
                        <Select value={sellerCountry} onValueChange={(v) => applyCountry(v as SellerCountry)}>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="se">{t('seller_country_se')}</SelectItem>
                            <SelectItem value="eu">{t('seller_country_eu')}</SelectItem>
                            <SelectItem value="noneu">{t('seller_country_noneu')}</SelectItem>
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
                    <p className="text-xs text-muted-foreground">
                      {sellerCountry === 'eu' ? t('seller_country_eu_hint') : t('seller_country_noneu_hint')}
                    </p>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setShowSaveTemplate(true)}
                      disabled={templateSeedLines.length < 2}
                    >
                      {t('save_as_template')}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowRowEditor((v) => !v)}
                    >
                      {showRowEditor ? t('hide_row_editor') : t('edit_rows')}
                    </Button>
                  </div>
              <table className="w-full border-collapse text-[13px]">
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
                            className="h-7 w-7"
                            aria-label={t('remove_row')}
                            onClick={() => removeRow(row.key)}
                          >
                            <X className="h-3.5 w-3.5" />
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
                      <Lock
                        className="mr-1.5 inline h-3.5 w-3.5 align-[-2px] text-muted-foreground"
                        aria-hidden="true"
                      />
                      {liabilityAccount}{' '}
                      <span className="text-muted-foreground">{accountName(liabilityAccount)}</span>
                    </td>
                    <td className={`${TD_CLASS} text-right`} />
                    <td className={`${TD_CLASS} text-right tabular-nums`}>
                      {parsedAmount.toFixed(2)} {currency}
                    </td>
                    <td className={TD_CLASS} />
                  </tr>
                  <tr>
                    <td className={`${TD_CLASS} font-medium`}>
                      {showRowEditor && (
                        <Button type="button" variant="ghost" size="sm" className="-ml-2" onClick={addRow}>
                          <Plus className="mr-1 h-3.5 w-3.5" />
                          {t('add_row')}
                        </Button>
                      )}
                    </td>
                    <td className={`${TD_CLASS} text-right font-medium tabular-nums`}>
                      {totalDebit.toFixed(2)}
                    </td>
                    <td className={`${TD_CLASS} text-right font-medium tabular-nums`}>
                      {totalCredit.toFixed(2)}
                    </td>
                    <td className={TD_CLASS}>
                      {bookingBalanced && bookingRowsValid ? (
                        <Badge variant="outline" className="font-normal text-positive">
                          {t('balanced')}
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="font-normal text-attn">
                          {t('unbalanced')}
                        </Badge>
                      )}
                    </td>
                  </tr>
                </tbody>
              </table>
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

          <DialogFooter>
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
                disabled={
                  submitting ||
                  upload.phase === 'uploading' ||
                  bookingMode !== 'book' ||
                  !bookingBalanced ||
                  !bookingRowsValid
                }
              >
                {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
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
              <DialogContent className="sm:max-w-lg">
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
        <DialogContent className="sm:max-w-md">
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
            <Button type="button" variant="destructive" onClick={handleDelete} disabled={submitting}>
              {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('delete_confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Payout dialog */}
      <Dialog open={paying} onOpenChange={(open) => !open && !submitting && setPaying(false)}>
        <DialogContent className="sm:max-w-md">
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
            <Button type="button" onClick={handlePayout} disabled={submitting || !cashAccount}>
              {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('payout_confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
