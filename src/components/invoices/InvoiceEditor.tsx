'use client'

import { Fragment, useState, useEffect, useRef, useMemo, useId } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { createClient } from '@/lib/supabase/client'
import { useForm, useFieldArray, Controller, type FieldErrors } from 'react-hook-form'
import { Reorder } from 'framer-motion'
import { SortableRow } from '@/components/ui/sortable-row'
import { AutoGrowTextarea } from '@/components/invoices/AutoGrowTextarea'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { addDays, format } from 'date-fns'
import { POPOVER_SURFACE_CLASS, POPOVER_ENTER_CLASS } from '@/components/ui/popover-surface'
import { Input } from '@/components/ui/input'
import { TagInput } from '@/components/ui/tag-input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Badge, badgeVariants } from '@/components/ui/badge'
import { HelpPopover } from '@/components/ui/help-popover'
import { useToast } from '@/components/ui/use-toast'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { HOVER_REVEAL_CLASS, QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import {
  explainVatTreatment,
  getVatRules,
  requiresSwedishVatAcknowledgement,
} from '@/lib/invoices/vat-rules'
import {
  resolveLineVatRates,
  planCustomerSwitchVatSnap,
  FALLBACK_VAT_RATE,
} from '@/components/invoices/line-vat-rates'
import { VatTreatmentNotice } from '@/components/invoices/VatTreatmentNotice'
import { Checkbox } from '@/components/ui/checkbox'
import {
  defaultGronTeknikWorkType,
  deriveNextStep,
  deriveRequiresHousing,
  filterArticleSuggestions,
  isComposingKey,
  resolveEntryKey,
  type EntryGhostCell,
  type EntryKeyAction,
  planDueDateSync,
  planCustomerTermsFill,
  type NextStep,
} from '@/components/invoices/invoice-editor-flow'
import { sortArticles } from '@/lib/articles/sort'
import ArticleCombobox from '@/components/invoices/ArticleCombobox'
import { getAmountToPay } from '@/lib/invoices/rounding'
import { computeLineNet, hasLineDiscount } from '@/lib/invoices/line-amounts'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ChevronDown, Loader2, X, Landmark, MoreVertical, CalendarClock, Tags, Package, Percent, Plus, Trash2 } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { useUnsavedChanges } from '@/lib/hooks/use-unsaved-changes'
import CustomerForm from '@/components/customers/CustomerForm'
import CustomerCombobox from '@/components/customers/CustomerCombobox'
import { BankDetailsSetupForm } from '@/components/invoices/BankDetailsSetupForm'
import { FirstInvoiceLogoPrompt } from '@/components/invoices/FirstInvoiceLogoPrompt'
import { useCompany, useCapability } from '@/contexts/CompanyContext'
import { useAccounts, useArticles, useCompanySettings, useCustomers, useFiscalPeriods } from '@/lib/reference-data/hooks'
import { isInvoiceTypeEnabled } from '@/lib/invoices/invoice-type-toggles'
import { invalidateReferenceData } from '@/lib/reference-data/invalidate'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'
import {
  DEDUCTION_TYPES,
  GRON_TEKNIK_WORK_TYPES,
  ROT_WORK_TYPES,
  RUT_WORK_TYPES,
  articleDeductionPrefill,
  computeDeduction,
  deductionCapWarnings,
  deductionLineIssues,
  deductionTypeForWorkType,
  gronTeknikWorkType,
  SCHABLON_WORK_TYPES,
  type DeductionType,
  type PriorYearDeductions,
} from '@/lib/invoices/rot-rut-rules'
import { UNDECRYPTABLE_PERSONAL_NUMBER_MASK } from '@/lib/customers/mask-personal-number'
import { roundOre } from '@/lib/money'
import { isFiscalYear } from '@/lib/invariants'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import AccrualPeriodControl from '@/components/bookkeeping/AccrualPeriodControl'
import AccountCombobox from '@/components/bookkeeping/AccountCombobox'
import LineDimensionFields from '@/components/dimensions/LineDimensionFields'
import { DEFAULT_DEFERRED_REVENUE_ACCOUNT } from '@/lib/bookkeeping/accruals/account-suggestions'
import { countCalendarMonths } from '@/lib/bookkeeping/accruals/compute'
import { cashAccountPayee, isUsableInvoicePayee } from '@/lib/cash-accounts/invoice-payee'
import type { InvoiceCopyInitial } from '@/lib/invoices/copy-invoice'
import { INVOICE_POSTING_ACCOUNT_REGEX } from '@/lib/invoices/posting-account'
import { UNIT_DATALIST_ID, UNIT_MAX_LENGTH } from '@/lib/invoices/units'
import UnitDatalist from '@/components/invoices/UnitDatalist'
import {
  buildInvoiceWritePayload,
  buildSelfBilledPayload,
  hasDimensionValues,
} from '@/lib/invoices/editor-payload'
import { InvoiceEditorShell, type EditorPane } from '@/components/invoices/editor/InvoiceEditorShell'
import { EditorTopBar, type TopBarMenuEntry } from '@/components/invoices/editor/EditorTopBar'
import { EditorPreviewPane } from '@/components/invoices/editor/EditorPreviewPane'
import { EditorEmailPreview, type EmailTextOverride } from '@/components/invoices/editor/EditorEmailPreview'
import { EditorStatusLine } from '@/components/invoices/editor/EditorStatusLine'
import { SendConfirmDialog, type ConfirmVoucher } from '@/components/invoices/editor/SendConfirmDialog'
import { useInvoicePdfPreview } from '@/components/invoices/editor/use-editor-previews'
import {
  resolveChannelOptions,
  resolveEffectiveChannel,
  type ChannelContext,
  type EditorChannel,
  type EmailBlockReason,
} from '@/lib/invoices/editor/channel'
import {
  booksOnIssue as resolveBooksOnIssue,
  resolveEditorMenu,
  resolvePrimaryAction,
  resolveSendLabel,
  type EditorIntent,
} from '@/lib/invoices/editor/primary-action'
import { resolveEditorStatusLine } from '@/lib/invoices/editor/status-line'
import { buildEditorPreviewRequest, withQuoteValidity } from '@/lib/invoices/editor/preview-request'
import { proposeDraftSendLines } from '@/lib/invoices/editor/voucher-preview'
import { persistAndSend } from '@/lib/invoices/editor/send-sequence'
import {
  invoiceDateLock,
  resolveDetailsChips,
  resolveDetailsExpansion,
  termDays,
  type DetailsChip,
  type DetailsReason,
} from '@/lib/invoices/editor/details'
import {
  compactDimensions,
  deductionsAvailable as resolveDeductionsAvailable,
  defaultLaborHours,
  rowOptionBadges,
  shouldShowDeductionColumn,
  shouldShowVatColumn,
  type RowBadge,
} from '@/lib/invoices/editor/rows'
import {
  buildEditorPaymentSummary,
  describeEditorPaymentSummary,
  paymentReason,
  paymentTermsTexts,
  type EditorPaymentSummaryInput,
} from '@/lib/invoices/editor/payment-summary'
import { companyWithInvoicePaymentAccount } from '@/lib/invoices/payment-accounts'
import { EditorSection } from '@/components/invoices/editor/EditorSection'
import { DetailsChips } from '@/components/invoices/editor/DetailsChips'
import { PaymentSummary } from '@/components/invoices/editor/PaymentSummary'
import { PaymentPanel, type PaymentPanelScope } from '@/components/invoices/editor/PaymentPanel'
import { isMaskedPersonalNumber } from '@/lib/customers/mask-personal-number'
import { EMAIL_PATTERN, parseInvoiceRecipientText } from '@/lib/invoices/email-recipients'
import {
  CURRENCIES,
  INVOICE_QR_MODES,
  type Article,
  type CashAccount,
  type CompanySettings as CompanySettingsRow,
  type CreateCustomerInput,
  type Currency,
  type Customer,
  type EntityType,
  type Invoice,
  type InvoiceDocumentType,
  type InvoiceItem,
  type InvoicePayeeDefault,
  type InvoiceQrMode,
} from '@/types'

const currencies: readonly Currency[] = CURRENCIES

// Payment term used before a customer default or a hand-picked due date says
// otherwise. 30 dagar netto is the Swedish B2B norm.
const DEFAULT_PAYMENT_TERM_DAYS = 30

// A draft invoice + its line items, as fetched for the edit flow.
export type InvoiceForEdit = Invoice & { items: InvoiceItem[] }

// The one-screen editor (/invoices/new, /invoices/[id]/edit): the form on
// the left, the live PDF and email on the right, sent from the top bar
// through one confirm dialog. `create` starts empty, `copy` from another
// invoice, `edit` from an existing DRAFT (saved via PATCH; sending it is in
// the caret menu).
export type InvoiceEditorProps = (
  | { mode?: 'create' }
  | { mode: 'edit'; initial: InvoiceForEdit }
  | { mode: 'copy'; initial: InvoiceCopyInitial }
) & {
  /** Open with the självfaktura tab preselected (the "Självfaktura" entry in
   *  the invoice list's split button). Create mode only. */
  initialSelfBilled?: boolean
  /** Open with this document type preselected (the "Ny offert" entry in the
   *  invoice list's split button). Create mode only. */
  initialDocumentType?: InvoiceDocumentType
}

// Subset of Article fields the line picker needs to pre-fill a row.
type ArticleOption = Pick<
  Article,
  'id' | 'article_number' | 'name' | 'type' | 'unit' | 'price_excl_vat' | 'vat_rate' | 'revenue_account' | 'currency' | 'housework_type'
>

function RequiredMark() {
  return <span className="text-destructive ml-0.5" aria-hidden="true">*</span>
}

// Borderless in-table cell input: quiet at rest, beige on hover, ringed on
// focus. rounded-sm: nested leaf inside the rows surface (radius ladder).
const CELL_INPUT_CLASS =
  'rounded-sm border border-transparent bg-transparent px-2 py-1 text-[13px] transition-colors duration-150 hover:bg-secondary/60 focus-visible:bg-background focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring placeholder:text-muted-foreground/60'

// Ghost cell in the entry row: previews the append default in the italic
// muted tone, hovers like a cell input so it reads as clickable.
const ENTRY_GHOST_CLASS =
  'rounded-sm border border-transparent bg-transparent px-2 py-1 text-[13px] italic text-muted-foreground/50 tabular-nums transition-colors duration-150 hover:bg-secondary/60 cursor-text'

// The add-row links under the table. Quiet links on desktop, inflated to a
// 40px touch target on coarse pointers: on Android they are the only way into
// a row (issue #2447), so they have to be comfortably tappable.
const ADD_ROW_LINK_CLASS = cn(
  QUIET_LINK_CLASS,
  'inline-flex items-center pointer-coarse:min-h-10',
)

// Row-control icon button: 24px visual hit area in dense rows (per the row
// chrome decision), inflated to a 40px touch target on coarse pointers.
const ROW_ICON_BUTTON_CLASS =
  'flex min-h-6 min-w-6 items-center justify-center rounded-sm p-1 text-muted-foreground transition-colors duration-150 hover:bg-secondary/60 hover:text-foreground pointer-coarse:min-h-10 pointer-coarse:min-w-10'

// Compact borderless Select trigger for in-table cells (unit, VAT).
const CELL_SELECT_TRIGGER_CLASS =
  'h-7 w-auto gap-1 rounded-sm border-transparent bg-transparent px-2 py-1 text-[13px] shadow-none hover:bg-secondary/60 tabular-nums'

// Antal and Enhet share one cell: one hover and focus surface around two
// borderless inputs, so "6 tim" reads as one value.
const QTY_UNIT_CELL_CLASS =
  'flex items-center rounded-sm border border-transparent transition-colors duration-150 hover:bg-secondary/60 focus-within:bg-background focus-within:ring-1 focus-within:ring-ring'
const QTY_UNIT_INPUT_CLASS =
  'min-w-0 bg-transparent py-1 text-[13px] tabular-nums focus-visible:outline-none placeholder:text-muted-foreground/60 [&::-webkit-calendar-picker-indicator]:hidden'

// The row table's columns: Beskrivning, Antal (with Enhet), à-pris, then Moms
// and Avdrag only when they say something, Belopp and the row menu. Literal
// classes so Tailwind sees every variant.
const ROW_GRID_BASE = 'grid grid-cols-[minmax(6rem,1fr)_5.5rem_4.5rem_5rem_1.5rem] items-center gap-1'
const ROW_GRID_ONE_EXTRA = 'grid grid-cols-[minmax(6rem,1fr)_5.5rem_4.5rem_4rem_5rem_1.5rem] items-center gap-1'
const ROW_GRID_TWO_EXTRA = 'grid grid-cols-[minmax(6rem,1fr)_5.5rem_4.5rem_4rem_4rem_5rem_1.5rem] items-center gap-1'

// The quiet field look of the one-line note and the claim fields.
const FIELD_LABEL_CLASS = 'text-[13px] font-normal'
const FIELD_HINT_CLASS = 'text-[12.5px] text-muted-foreground'

// The Avdrag cell: a quiet picker in the row, like the Moms cell.
const DEDUCTION_CELL_CLASS =
  'inline-flex h-7 items-center gap-1 rounded-sm px-1 text-[13px] transition-colors duration-150 hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'

// Anteckning: one line that grows with the text, in the field look.
const NOTE_INPUT_CLASS =
  'w-full rounded-lg border border-input bg-card px-4 py-2 text-[13px] transition-colors duration-150 placeholder:text-muted-foreground/60 focus-visible:border-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/20'

// Sentinel for "the company default" in the payee select: an empty option
// value renders as the placeholder in Radix Select.
const PAYEE_DEFAULT = '__default__'

/** "Företagskonto (1930)" or the bare ledger account when the row has no name. */
function payeeAccountLabel(account: CashAccount): string {
  const name = account.name?.trim()
  return name ? `${name} (${account.ledger_account})` : account.ledger_account
}

// The intents that go through the confirm dialog: a send, or a create
// without sending (both lock a number).
type ConfirmIntent = Extract<EditorIntent, { kind: 'send' } | { kind: 'create' }>

// Why email is not possible, as keys of the invoice_editor_shell namespace.
const EMAIL_BLOCK_KEYS: Record<EmailBlockReason, string> = {
  not_emailable: 'email_block_not_emailable',
  sandbox: 'email_block_sandbox',
  no_email_plan: 'email_block_no_email_plan',
  no_customer_email: 'email_block_no_customer_email',
}

export default function InvoiceEditor(props: InvoiceEditorProps = { mode: 'create' }) {
  // Edit mode pre-fills the form from an existing draft and saves via PATCH.
  const isEditMode = props.mode === 'edit'
  const isCopyMode = props.mode === 'copy'
  const initial = props.mode === 'edit' ? props.initial : null
  const copyInitial = props.mode === 'copy' ? props.initial : null
  const initialOreRounding = initial?.ore_rounding ?? copyInitial?.ore_rounding
  const router = useRouter()
  const { toast } = useToast()
  const { canWrite } = useCanWrite()
  const { company, role, isSandbox } = useCompany()
  const hasEmailSend = useCapability(CAPABILITY.email_send)
  const supabase = createClient()
  const locale = useLocale() as ErrorLocale
  const t = useTranslations('invoice_editor')
  const tShell = useTranslations('invoice_editor_shell')
  const tForm = useTranslations('invoice_editor_form')
  const tPay = useTranslations('invoice_editor_pay')
  const tSend = useTranslations('invoice_send_dialog')
  const tNav = useTranslations('nav')
  const tVat = useTranslations('vat_treatment_notice')
  const ts = useTranslations('self_billing')
  const ta = useTranslations('accruals')
  // Owner/admin: extra email copies (as in SendInvoiceDialog) and payment
  // details set up from the status line.
  const isCompanyAdmin = role === 'owner' || role === 'admin'
  // Normal customer invoice (default) or a received self-billing invoice
  // (mottagen självfaktura, ML 17 kap 15§). The mode is chosen upstream in
  // the Ny faktura split button (?self=1) and is fixed for the editor's
  // lifetime: the two flows are separate views, not tabs (founder call
  // 2026-08-17). Self-billing is never available when editing a draft.
  const mode: 'invoice' | 'self_billed' =
    props.initialSelfBilled && !isEditMode ? 'self_billed' : 'invoice'
  const createDocumentType: InvoiceDocumentType =
    !isEditMode && !isCopyMode && !props.initialSelfBilled && props.initialDocumentType
      ? props.initialDocumentType
      : 'invoice'
  // Company-wide opt-in from the invoice settings page: the whole payment
  // link section (manual field + Stripe auto toggle) stays hidden until the
  // company enables it. The send routes enforce the same setting server-side
  // (maybeCreatePaymentLinkForInvoice), so this is presentation, not the gate.
  const [paymentLinksEnabled, setPaymentLinksEnabled] = useState(false)
  // An already-linked invoice keeps showing the section even when the
  // setting is off, so the user can still see or clear the old link.
  const hasExistingPaymentLink = Boolean(initial?.payment_link_url)
  // Active Stripe connection: drives the "auto payment link" toggle in the
  // payment link section. Absent extension or no connection → toggle hidden.
  const [stripeConnected, setStripeConnected] = useState(false)
  useEffect(() => {
    if (!paymentLinksEnabled) return
    if (!ENABLED_EXTENSION_IDS.has('stripe')) return
    let cancelled = false
    fetch('/api/extensions/ext/stripe/status')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data?.connection?.status === 'active') setStripeConnected(true)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [paymentLinksEnabled])
  // Edit mode: the draft's stored ROT/RUT personnummer, in display form
  // (YYYYMMDD-XXXX). The row only carries ciphertext + last four digits, and
  // the mask must come from the server so the browser never holds both
  // halves of the number. Read once per draft; the hint shows it.
  const storedPersonnummerId = initial?.deduction_personnummer_last4 ? initial.id : null
  const [storedPersonnummerMasked, setStoredPersonnummerMasked] = useState<string | null>(null)
  useEffect(() => {
    if (!storedPersonnummerId) return
    let cancelled = false
    fetch(`/api/invoices/${encodeURIComponent(storedPersonnummerId)}/rot-rut`)
      .then((res) => (res.ok ? res.json() : null))
      .then((payload: { data?: { deduction_personnummer_masked?: string | null } } | null) => {
        if (!cancelled) setStoredPersonnummerMasked(payload?.data?.deduction_personnummer_masked ?? null)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [storedPersonnummerId])

  // The item schema is memoised on translations only; whether ROT/RUT claim
  // completeness applies depends on the document type (proformas, delivery
  // notes and self-billing have no deduction model and the strip never
  // renders), so read that through a ref at validation time.
  const rotRutCompletenessAppliesRef = useRef(false)

  const schema = useMemo(() => {
    const itemSchema = z.object({
      // 'text' rows carry only a (possibly empty) description: a free-text or
      // blank spacer line. Product rows keep the original requirements,
      // enforced in the refine below so the base shape stays uniform.
      line_type: z.enum(['product', 'text']).optional(),
      description: z.string(),
      quantity: z.number(),
      unit: z.string(),
      unit_price: z.number(),
      // Rabatt i procent per rad (⋮ menu). null = no discount.
      discount_percent: z
        .number()
        .min(0, t('validation_discount_range'))
        .max(100, t('validation_discount_range'))
        .nullable()
        .optional(),
      vat_rate: z.number().min(0).max(25),
      // Article linkage (artikelregister). Optional: free-text lines omit them.
      article_id: z.string().nullable().optional(),
      // Kundorder line link: an invoice created from a sales order carries it
      // per item; the draft editor replaces items wholesale on save, so the
      // field must round-trip or the order line becomes re-invoiceable.
      sales_order_item_id: z.string().nullable().optional(),
      revenue_account: z
        .string()
        .regex(INVOICE_POSTING_ACCOUNT_REGEX, t('posting_account_invalid'))
        .nullable()
        .optional(),
      // Skattereduktion per line (ROT, RUT, grön teknik). Optional: null means
      // "no deduction".
      deduction_type: z.enum(DEDUCTION_TYPES).nullable().optional(),
      labor_hours: z.number().nonnegative().nullable().optional(),
      work_type: z.string().nullable().optional(),
      housing_designation: z.string().nullable().optional(),
      apartment_number: z.string().nullable().optional(),
      brf_org_number: z.string().nullable().optional(),
      // Periodisering (förutbetald intäkt). Active when balance account is
      // non-null; both period dates are then required (refine below).
      accrual_period_start: z.string().nullable().optional(),
      accrual_period_end: z.string().nullable().optional(),
      accrual_balance_account: z.string().nullable().optional(),
      // Per-item dimensions bag ({sie_dim_no: code}, dimensions PR7). Stored
      // as-is; the server merges it over the invoice's default_dimensions on
      // the item's revenue line at booking time.
      dimensions: z.record(z.string(), z.string()).nullable().optional(),
    }).superRefine((item, ctx) => {
      if (item.accrual_balance_account != null) {
        const start = item.accrual_period_start
        const end = item.accrual_period_end
        let invalid = !start || !end || end < start
        if (!invalid) {
          try {
            invalid = countCalendarMonths(start as string, end as string) < 2
          } catch {
            invalid = true
          }
        }
        if (invalid) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['accrual_period_end'],
            message: ta('validation_period'),
          })
        }
      }
      // ROT/RUT claim completeness, mirrored from CreateInvoiceItemSchema:
      // arbetstyp + arbetstimmar are what the Skatteverket claim needs, and
      // creation is the last moment the line is editable.
      if (item.deduction_type === 'gron_teknik' && rotRutCompletenessAppliesRef.current && item.line_type !== 'text') {
        // Grön teknik: the installation type decides the rate and is required
        // on every flagged row. Hours are checked per installation type on
        // the form (a material row may leave them empty), see below.
        if (!gronTeknikWorkType(item.work_type)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['work_type'], message: t('deduction_gron_teknik_work_type_required') })
        }
      } else if (item.deduction_type && rotRutCompletenessAppliesRef.current && item.line_type !== 'text') {
        const workType = item.work_type?.trim() || null
        if (!workType) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['work_type'], message: t('deduction_work_type_required') })
        } else if (deductionTypeForWorkType(workType) !== item.deduction_type) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['work_type'], message: t('deduction_work_type_mismatch') })
        }
        const isSchablon = workType != null && SCHABLON_WORK_TYPES.includes(workType)
        if (!isSchablon && !(typeof item.labor_hours === 'number' && item.labor_hours > 0)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['labor_hours'], message: t('deduction_hours_required') })
        }
      }
      if (item.line_type === 'text') return
      if (item.description.trim().length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['description'], message: t('validation_description_required') })
      }
      if (!(item.quantity >= 0.01)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['quantity'], message: t('validation_quantity_min') })
      }
      if (item.unit.trim().length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['unit'], message: t('validation_unit_required') })
      }
      // Negative unit prices are allowed: discount lines (e.g. "Rabatt -100")
      // are a valid way to reduce an invoice total. The backend schema accepts
      // them too (see lib/api/schemas.ts CreateInvoiceItemSchema). An empty
      // price field is still rejected by the base `unit_price: z.number()` type
      // (NaN), so we only need to allow the sign here.
    })
    return z.object({
      customer_id: z.string().min(1, t('validation_customer_required')),
      invoice_date: z.string().min(1, t('validation_invoice_date_required')),
      due_date: z.string().min(1, t('validation_due_date_required')),
      // Quotes only: the expiry date ("Giltig till"). due_date mirrors it on
      // the wire (the column is NOT NULL); required for quotes via the
      // superRefine below so the error lands under the visible field.
      valid_until: z.string().optional(),
      delivery_date: z.string().optional(),
      currency: z.enum(CURRENCIES),
      // Bank account the customer pays to; '' = the company default per currency.
      payment_cash_account_id: z.string().optional(),
      // This invoice's own QR code (Betalning och utseende, "Bara den här");
      // null = the company's invoice_qr_mode.
      qr_mode: z.enum(INVOICE_QR_MODES).nullable().optional(),
      document_type: z.enum(['invoice', 'proforma', 'delivery_note', 'quote']),
      your_reference: z.string().optional(),
      our_reference: z.string().optional(),
      invoice_marking: z.string().optional(),
      notes: z.string().optional(),
      // Optional online payment link (pasted from e.g. the Stripe dashboard).
      // https-only: mirrors the server-side CreateInvoiceSchema gate.
      payment_link_url: z
        .string()
        .optional()
        .refine(
          (v) => {
            if (!v || !v.trim()) return true
            try {
              return new URL(v).protocol === 'https:'
            } catch {
              return false
            }
          },
          { message: t('validation_payment_link_https') },
        ),
      // Opt-out for the automatic Stripe payment link on send (only rendered
      // when the company has an active Stripe connection).
      payment_link_auto: z.boolean().optional(),
      // Self-billing received (mottagen självfaktura). Present in the form for
      // both modes; required only in self_billed mode: enforced in submitSelfBilled.
      external_invoice_number: z.string().optional(),
      self_billing_agreement_ref: z.string().optional(),
      received_date: z.string().optional(),
      // Invoice-level ROT/RUT claim info. Personnummer is plaintext on
      // the wire; the API encrypts it before storage. The API additionally
      // accepts the bostadsrätt pair (deduction_apartment_number +
      // deduction_brf_org_number): no editor UI for it yet, rot i
      // bostadsrätt data enters via API/MCP until the payout-file UI ships.
      deduction_personnummer: z.string().optional(),
      deduction_housing_designation: z.string().optional(),
      items: z.array(itemSchema).min(1, t('validation_min_one_row')),
    }).superRefine((data, ctx) => {
      if (data.document_type === 'quote' && !data.valid_until) {
        ctx.addIssue({
          code: 'custom',
          path: ['valid_until'],
          message: t('validation_valid_until_required'),
        })
      }
      // Grön teknik rules that span rows, from the same helper the API
      // validates with: hours on at least one row per installation type, and
      // no grön teknik next to ROT/RUT. The per-row checks run on the item.
      if (rotRutCompletenessAppliesRef.current) {
        for (const issue of deductionLineIssues(data.items)) {
          if (issue.code === 'gronTeknikHoursMissing') {
            ctx.addIssue({
              code: 'custom',
              path: ['items', issue.index, 'labor_hours'],
              message: t('deduction_gron_teknik_hours_required'),
            })
          } else if (issue.code === 'gronTeknikMixed') {
            ctx.addIssue({
              code: 'custom',
              path: ['items', issue.index, 'deduction_type'],
              message: t('deduction_gron_teknik_mixed'),
            })
          }
        }
      }
    })
  }, [t, ta])

  type FormData = z.infer<typeof schema>

  // Reference data from the session cache (lib/reference-data): customers,
  // articles, posting accounts and company settings are read from SWR
  // instead of four fetches per mount, so a cached editor renders every
  // field populated on the first paint and reopening the dialog costs no
  // requests. Customers come through /api/customers, which masks the
  // personnummer column; nothing here rendered it.
  const { customers: cachedCustomers, isLoading: customersLoading, error: customersError } = useCustomers()
  // Archived customers (v1 API soft-delete) are not offered in the picker
  // (/api/customers filters archived_at IS NULL). An existing draft or copied
  // invoice may still point at one (archiving only refuses when open invoices
  // exist, drafts do not count), so that single row is fetched on its own and
  // kept in the list, or the select would render blank.
  const keepCustomerId = initial?.customer_id ?? copyInitial?.customer_id ?? null
  const [keptCustomer, setKeptCustomer] = useState<Customer | null>(null)
  useEffect(() => {
    if (!keepCustomerId || customersLoading) return
    if (cachedCustomers.some((c) => c.id === keepCustomerId)) return
    let cancelled = false
    fetch(`/api/customers/${encodeURIComponent(keepCustomerId)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((json: { data?: Customer } | null) => {
        if (!cancelled && json?.data) setKeptCustomer(json.data)
      })
      .catch(() => {
        // The picker simply shows no selection for a customer that no longer resolves.
      })
    return () => {
      cancelled = true
    }
  }, [keepCustomerId, customersLoading, cachedCustomers])
  const customers = useMemo(() => {
    if (!keptCustomer || cachedCustomers.some((c) => c.id === keptCustomer.id)) return cachedCustomers
    return [...cachedCustomers, keptCustomer].sort((a, b) => a.name.localeCompare(b.name))
  }, [cachedCustomers, keptCustomer])
  const {
    settings: companySettings,
    updateSettings: patchCompanySettings,
    refetch: refetchCompanySettings,
  } = useCompanySettings()
  const { periods: fiscalPeriods } = useFiscalPeriods()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isSavingDraft, setIsSavingDraft] = useState(false)
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null)
  // The confirm dialog's intent (a send on a channel, or create without
  // sending), opened from the top bar, its caret menu or Cmd/Ctrl+Enter.
  const [confirmIntent, setConfirmIntent] = useState<ConfirmIntent | null>(null)
  // An intent waiting behind the bank-details setup or the first-invoice logo
  // prompt; it resumes into the confirm once they close.
  const [queuedIntent, setQueuedIntent] = useState<ConfirmIntent | null>(null)
  const [logoPromptDone, setLogoPromptDone] = useState(false)
  // Explicit confirm for Swedish VAT to an EU customer whose reverse charge
  // is blocked (#2749). Reset every time the confirm dialog closes.
  const [swedishVatAcknowledged, setSwedishVatAcknowledged] = useState(false)
  const [pendingData, setPendingData] = useState<FormData | null>(null)
  // The channel the user picked in the caret menu; null = the default
  // (lib/invoices/editor/channel.ts).
  const [channelChoice, setChannelChoice] = useState<EditorChannel | null>(null)
  // The Mejl tab: this send's own subject and message (null = the company's
  // or the stock texts) and its extra copies.
  const [emailOverride, setEmailOverride] = useState<EmailTextOverride | null>(null)
  const [extraCcText, setExtraCcText] = useState('')
  // Bumped when something the PDF prints changed outside the form (a logo
  // upload, new bank details): re-renders the preview.
  const [previewRefreshKey, setPreviewRefreshKey] = useState(0)
  const [, setDefaultNotes] = useState<string | null>(null)
  const [isCreateCustomerOpen, setIsCreateCustomerOpen] = useState(false)
  // Name typed into the picker when the user chose "Skapa kund" from its
  // no-match state; '' when opened from the link below the picker.
  const [createCustomerPrefill, setCreateCustomerPrefill] = useState('')
  const [isCreatingCustomer, setIsCreatingCustomer] = useState(false)
  // The inline "Lägg till betalningsuppgifter" form in the Betalning section.
  const [addingPayee, setAddingPayee] = useState(false)
  // "Betalning och utseende": the panel that replaces the form column, and
  // its scope (company defaults or this invoice only).
  const [paymentPanelOpen, setPaymentPanelOpen] = useState(false)
  const [paymentPanelScope, setPaymentPanelScope] = useState<PaymentPanelScope>('all')
  const [accountingMethod, setAccountingMethod] = useState<'accrual' | 'cash'>('accrual')
  // Öresavrundning is display-only. In edit mode the draft's stored flag wins;
  // otherwise it defaults to the company-wide setting (loaded below).
  const [oreRounding, setOreRounding] = useState<boolean>(
    typeof initialOreRounding === 'boolean' ? initialOreRounding : true,
  )
  const [vatRegistered, setVatRegistered] = useState<boolean>(true)
  const [numberPreview, setNumberPreview] = useState<string | null>(null)
  const [logoUrl, setLogoUrl] = useState<string | null>(null)
  // Artikelregister: active articles for the line picker + which line is mid quick-create.
  const { articles: articleRows } = useArticles()
  // Numeric-aware order by article number ('2' before '10', unnumbered last):
  // the picker should follow the user's own numbering, not the alphabet.
  const articles = useMemo(() => sortArticles(articleRows as ArticleOption[]), [articleRows])
  const [savingArticleIndex, setSavingArticleIndex] = useState<number | null>(null)
  // Active balance-sheet and revenue accounts for the optional per-line
  // posting override, plus which rows currently show that picker.
  const { accounts: activeAccounts } = useAccounts()
  const postingAccounts = useMemo(
    () => activeAccounts.filter((account) => account.account_class >= 1 && account.account_class <= 3),
    [activeAccounts],
  )
  const [accountOverrideRows, setAccountOverrideRows] = useState<Set<number>>(new Set())
  // Rabatt per rad: rows whose discount strip is open (⋮ menu), same
  // lifecycle as the account override above. A stored discount also opens it.
  const [discountRows, setDiscountRows] = useState<Set<number>>(new Set())
  // Dimension tagging (kostnadsställe/projekt, dimensions PR7). Affordances
  // render only when company_settings.dimensions_enabled: a UI-visibility
  // gate; a draft that already carries bags still round-trips untouched when
  // the toggle is off. defaultDims is the invoice-level default; per-item
  // overrides live on the form items and open via the row ⋮ menu (same
  // open/close bookkeeping as accountOverrideRows).
  const [dimensionsEnabled, setDimensionsEnabled] = useState(false)
  const [defaultDims, setDefaultDims] = useState<Record<string, string>>(
    initial?.default_dimensions ?? copyInitial?.default_dimensions ?? {},
  )
  const [dimensionOverrideRows, setDimensionOverrideRows] = useState<Set<number>>(new Set())
  // Snabbflöde shell state: the collapsible Förval panel, the per-row article
  // re-link strip (opened from the row ⋮ menu; same index-Set bookkeeping as
  // accountOverrideRows), the unified entry row's autocomplete, and the brief
  // settle wash on a freshly committed row.
  // Detaljer opened by hand (a chip click); it also opens by itself for an
  // unusual value (lib/invoices/editor/details.ts).
  const [detailsOpen, setDetailsOpen] = useState(false)
  // "+ Märkning" and "+ Leveransdatum": the field shows once asked for.
  const [markingOpen, setMarkingOpen] = useState(false)
  const [deliveryOpen, setDeliveryOpen] = useState(false)
  const [defaultDimsOpen, setDefaultDimsOpen] = useState(false)
  // Periodisering strips opened from the row menu or the row's badge.
  const [accrualRows, setAccrualRows] = useState<Set<number>>(new Set())
  // Deduction rows whose arbetstimmar still follow the quantity (unit tim):
  // a typed value stops the following. Keyed by field id, stable on reorder.
  const autoHoursRef = useRef<Set<string>>(new Set())
  const [articlePickerRows, setArticlePickerRows] = useState<Set<number>>(new Set())
  const [entryQuery, setEntryQuery] = useState('')
  const [entryOpen, setEntryOpen] = useState(false)
  const [entryActiveIdx, setEntryActiveIdx] = useState(-1)
  const [settleIndex, setSettleIndex] = useState<number | null>(null)
  const entryInputRef = useRef<HTMLInputElement>(null)
  // The entry row and its suggestion popover share this wrapper: the blur
  // handler asks it whether focus is still inside before closing, so a tap on
  // a suggestion or ghost cell cannot lose the race (issue #2447).
  const entryRootRef = useRef<HTMLDivElement>(null)
  // Set when a keydown was swallowed as an IME composition artefact, so the
  // matching keyup (which arrives after compositionend with a real key) can
  // still act on an Android action-key press.
  const entryComposingKeyRef = useRef(false)
  const customerTriggerRef = useRef<HTMLInputElement>(null)
  const entryListId = useId()
  // True only when the user had zero invoices when this page loaded. The
  // post-create flow uses this to offer a one-shot "upload a logo?" prompt,
  // issue #520. Self-limits: once count > 0 it stays false.
  const [hadZeroInvoices, setHadZeroInvoices] = useState<boolean | null>(null)
  const [showLogoPrompt, setShowLogoPrompt] = useState(false)
  const pendingCustomerRef = useRef<Customer | null>(null)
  // In edit mode the first time we resolve the pre-filled customer we must NOT
  // re-derive due_date / forced VAT rates from it: those came from the saved
  // draft. Starts true for create (always derive), false for edit (skip once).
  const didInitialCustomerSync = useRef(!isEditMode)
  // The DEFAULT VAT rate of the customer currently selected. A customer switch
  // compares against it to tell an inherited line rate (follows the new
  // customer) from a deliberate one (left alone). Starts at the rate an empty
  // form's first line carries, before any customer is picked.
  const previousDefaultRateRef = useRef<number>(FALLBACK_VAT_RATE)
  // Edit and copy pre-fill the lines from an existing invoice, and the customer
  // that resolves first IS that invoice's customer: its rates are already
  // correct, so the first resolution must only RECORD the baseline, never snap.
  // A fresh form has no such baseline, so there the first pick does snap.
  const didSeedVatSnapBaseline = useRef(!(isEditMode || isCopyMode))

  // Edit mode: the claim card's property fields are restored from the first
  // line that names the property (ROT or grön teknik: stamped onto every
  // deduction line server-side at save time).
  const initialRotLine =
    initial?.items?.find((i) => i.deduction_type === 'rot' || i.deduction_type === 'gron_teknik') ?? null

  const {
    register,
    control,
    handleSubmit,
    watch,
    setValue,
    setError,
    setFocus,
    getValues,
    formState: { errors, isDirty, dirtyFields, isSubmitting: isFormSubmitting },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    // Edit mode pre-fills from the existing draft (header + every line incl.
    // line_type, article link, ROT/RUT and periodisering). The personnummer
    // can't be restored (stored encrypted): the user re-enters it if the
    // draft carries a ROT/RUT claim. Create mode keeps the original empty form.
    defaultValues: initial
      ? {
          // Null when the draft's customer was deleted (crm#263): start empty
          // so the user picks one and the required-customer message applies.
          customer_id: initial.customer_id ?? '',
          invoice_date: initial.invoice_date,
          due_date: initial.due_date,
          valid_until:
            initial.document_type === 'quote' ? initial.valid_until ?? initial.due_date : '',
          delivery_date: initial.delivery_date ?? '',
          currency: initial.currency,
          payment_cash_account_id: initial.payment_cash_account_id ?? '',
          qr_mode: initial.qr_mode ?? null,
          document_type: (initial.document_type ?? 'invoice') as InvoiceDocumentType,
          your_reference: initial.your_reference ?? '',
          our_reference: initial.our_reference ?? '',
          invoice_marking: initial.invoice_marking ?? '',
          notes: initial.notes ?? '',
          payment_link_url: initial.payment_link_url ?? '',
          payment_link_auto: initial.payment_link_auto ?? true,
          external_invoice_number: '',
          self_billing_agreement_ref: '',
          received_date: '',
          deduction_personnummer: '',
          deduction_housing_designation: initialRotLine?.housing_designation ?? '',
          items: (initial.items ?? []).map((item) => ({
            line_type: (item.line_type ?? 'product') as 'product' | 'text',
            description: item.description,
            quantity: item.quantity,
            unit: item.unit,
            unit_price: item.unit_price,
            discount_percent: hasLineDiscount(item.discount_percent) ? item.discount_percent : null,
            vat_rate: item.vat_rate ?? 25,
            article_id: item.article_id ?? null,
            sales_order_item_id: item.sales_order_item_id ?? null,
            revenue_account: item.revenue_account ?? null,
            deduction_type: item.deduction_type ?? null,
            labor_hours: item.labor_hours ?? null,
            work_type: item.work_type ?? null,
            housing_designation: item.housing_designation ?? null,
            apartment_number: item.apartment_number ?? null,
            brf_org_number: item.brf_org_number ?? null,
            accrual_period_start: item.accrual_period_start ?? null,
            accrual_period_end: item.accrual_period_end ?? null,
            accrual_balance_account: item.accrual_balance_account ?? null,
            dimensions: hasDimensionValues(item.dimensions) ? item.dimensions ?? null : null,
          })),
        }
      : copyInitial
        ? {
            customer_id: copyInitial.customer_id,
            invoice_date: '',
            due_date: '',
            valid_until: '',
            delivery_date: '',
            currency: copyInitial.currency,
            payment_cash_account_id: copyInitial.payment_cash_account_id ?? '',
            qr_mode: null,
            document_type: 'invoice' as InvoiceDocumentType,
            your_reference: '',
            our_reference: copyInitial.our_reference,
            invoice_marking: '',
            notes: copyInitial.notes,
            payment_link_url: '',
            payment_link_auto: true,
            external_invoice_number: '',
            self_billing_agreement_ref: '',
            received_date: '',
            deduction_personnummer: '',
            deduction_housing_designation: '',
            items: copyInitial.items,
          }
      : {
          customer_id: '',
          invoice_date: '',
          due_date: '',
          valid_until: '',
          currency: 'SEK',
          payment_cash_account_id: '',
          qr_mode: null,
          document_type: createDocumentType,
          payment_link_url: '',
          payment_link_auto: true,
          external_invoice_number: '',
          self_billing_agreement_ref: '',
          received_date: '',
          // The unified entry row (tfoot input) is how lines are born: a fresh
          // form starts with zero committed rows and the schema's min(1) plus
          // the next-step line ask for the first one.
          items: [],
        },
  })

  useUnsavedChanges(isDirty)

  // Set date defaults on client only to avoid hydration mismatch. Skipped when
  // editing: the draft's own dates are already loaded into the form.
  useEffect(() => {
    if (isEditMode) return
    setValue('invoice_date', format(new Date(), 'yyyy-MM-dd'))
    setValue('received_date', format(new Date(), 'yyyy-MM-dd'))
    setValue('due_date', format(addDays(new Date(), DEFAULT_PAYMENT_TERM_DAYS), 'yyyy-MM-dd'))
    setValue('valid_until', format(addDays(new Date(), 30), 'yyyy-MM-dd'))
  }, [])

  const { fields, append, remove, move } = useFieldArray({
    control,
    name: 'items',
  })

  // Drag-to-reorder (grip handle left of each row). framer-motion hands back
  // the fully reordered array; we translate the single displacement into a
  // react-hook-form move() so the registered inputs follow. The persisted
  // sort_order is the array index at create time, so reordering here is all
  // that's needed: no extra payload.
  const handleItemsReorder = (newOrder: typeof fields) => {
    const movedAt = newOrder.findIndex((f, i) => f.id !== fields[i]?.id)
    if (movedAt === -1) return
    const from = fields.findIndex((f) => f.id === newOrder[movedAt].id)
    if (from !== -1 && from !== movedAt) move(from, movedAt)
  }

  const watchItems = watch('items')
  const watchCurrency = watch('currency')
  const watchPayeeAccount = watch('payment_cash_account_id')
  // The company's bank accounts that may be printed as payee, and the default
  // per currency. Loaded once; the select only renders when there is a real
  // choice (two or more usable accounts for the invoice currency).
  const [payeeState, setPayeeState] = useState<{ accounts: CashAccount[]; defaults: InvoicePayeeDefault[] } | null>(null)
  useEffect(() => {
    let cancelled = false
    fetch('/api/cash-accounts/payee-defaults')
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (!cancelled && json?.data) setPayeeState(json.data)
      })
      .catch(() => {
        // Best-effort: without the list the invoice simply uses the default.
      })
    return () => {
      cancelled = true
    }
  }, [])
  const payeeOptions = useMemo(
    () => (payeeState ? payeeState.accounts.filter((a) => isUsableInvoicePayee(a, watchCurrency as Currency)) : []),
    [payeeState, watchCurrency],
  )
  const defaultPayee = useMemo(() => {
    const id = payeeState?.defaults.find((d) => d.currency === watchCurrency)?.cash_account_id
    return id ? payeeState?.accounts.find((a) => a.id === id) ?? null : null
  }, [payeeState, watchCurrency])
  // A currency change can make the chosen account unusable (no IBAN for
  // EUR): fall back to the default rather than submit an invalid choice.
  useEffect(() => {
    if (!payeeState || !watchPayeeAccount) return
    if (!payeeOptions.some((a) => a.id === watchPayeeAccount)) {
      setValue('payment_cash_account_id', '', { shouldDirty: true })
    }
  }, [payeeState, payeeOptions, watchPayeeAccount, setValue])
  const watchCustomerId = watch('customer_id')
  const watchDocumentType = watch('document_type') as InvoiceDocumentType
  // Subscribed at render level so the Förval chip line and the next-step line
  // stay live while the settings panel is collapsed.
  const watchInvoiceDate = watch('invoice_date')
  const watchDueDate = watch('due_date')
  const watchValidUntil = watch('valid_until')
  const watchReceivedDate = watch('received_date')
  const watchDeliveryDate = watch('delivery_date')
  const watchPaymentLinkUrl = watch('payment_link_url')
  const watchPaymentLinkAuto = watch('payment_link_auto')
  const watchPersonnummer = watch('deduction_personnummer')
  const watchHousingDesignation = watch('deduction_housing_designation')
  const watchExternalNumber = watch('external_invoice_number')

  // Förfallodatum follows fakturadatum on the current payment term. The term
  // itself is read back off the date pair on screen (customer default, loaded
  // draft, or a due date the user picked by hand), so moving the invoice date
  // to the end of the month keeps "30 dagar" instead of stranding the due date
  // where it was and making the user count days. See planDueDateSync.
  const dueDateSyncRef = useRef<{ previousInvoiceDate: string | null; terms: number }>({
    previousInvoiceDate: null,
    terms: DEFAULT_PAYMENT_TERM_DAYS,
  })
  useEffect(() => {
    const plan = planDueDateSync({
      invoiceDate: watchInvoiceDate ?? '',
      dueDate: watchDueDate ?? '',
      previousInvoiceDate: dueDateSyncRef.current.previousInvoiceDate,
      terms: dueDateSyncRef.current.terms,
    })
    dueDateSyncRef.current = {
      previousInvoiceDate: plan.previousInvoiceDate,
      terms: plan.terms,
    }
    if (plan.dueDate && plan.dueDate !== watchDueDate) {
      setValue('due_date', plan.dueDate, { shouldDirty: true, shouldValidate: true })
    }
  }, [watchInvoiceDate, watchDueDate, setValue])

  // After customers state updates with the new customer, select it
  useEffect(() => {
    const pending = pendingCustomerRef.current
    if (pending && customers.some((c) => c.id === pending.id)) {
      setValue('customer_id', pending.id, { shouldValidate: true, shouldDirty: true })
      setSelectedCustomer(pending)
      pendingCustomerRef.current = null
    }
  }, [customers, setValue])

  useEffect(() => {
    if (!customersError) return
    toast({
      title: t('load_customers_failed_title'),
      description: t('load_customers_failed_description'),
      variant: 'destructive',
    })
  }, [customersError, toast, t])

  // Apply a chosen article's defaults onto a line. Selecting "none" detaches the
  // article link (and its account override) but keeps the typed text/price so the
  // row becomes an editable free-text line.
  function applyArticle(index: number, articleId: string) {
    if (articleId === 'none') {
      setValue(`items.${index}.article_id`, null, { shouldDirty: true })
      setValue(`items.${index}.revenue_account`, null, { shouldDirty: true })
      return
    }
    const a = articles.find((x) => x.id === articleId)
    if (!a) return
    setValue(`items.${index}.article_id`, a.id, { shouldDirty: true })
    setValue(`items.${index}.description`, a.name, { shouldValidate: true, shouldDirty: true })
    if (a.unit) setValue(`items.${index}.unit`, a.unit, { shouldDirty: true })
    setValue(`items.${index}.unit_price`, Number(a.price_excl_vat) || 0, { shouldValidate: true, shouldDirty: true })
    // Only adopt the article's VAT rate when it belongs to the customer's
    // DEFAULT set, never to the wider permitted set. An article's stored rate is
    // its domestic rate; nothing on it says the supply is one of the ML 6 kap.
    // ones taxed where performed. Adopting 25% because the article says 25%
    // would silently put Swedish VAT on a reverse-charge invoice, so a foreign
    // business customer (single locked 0% default) keeps the line's rate and the
    // user picks 12%/6% explicitly when it really is a hotel night or a ticket.
    if (!vatRatePlan.hasSingleDefault && vatRatePlan.defaultRates.some((r) => r.rate === a.vat_rate)) {
      setValue(`items.${index}.vat_rate`, a.vat_rate, { shouldValidate: true, shouldDirty: true })
    }
    // The account override rides along regardless of rate; the engine ignores it
    // for reverse-charge/export and validates it against the chart of accounts.
    setValue(`items.${index}.revenue_account`, a.revenue_account ?? null, { shouldDirty: true })
    // Skattereduktion: the article's housework_type decides the line's
    // deduction kind and, when it is a Skatteverket arbetstypskod, its work
    // type too. Legacy articles carry only the kind (`ROT`/`RUT`): those
    // pre-fill the deduction and keep a same-kind arbetstyp already chosen on
    // the row. An article WITHOUT any housework flag, and a goods (vara)
    // article with a ROT/RUT flag (ROT/RUT is labor only), re-defaults the
    // row to no deduction, the same overwrite semantics as description/price
    // above: a material article picked onto a previously RUT-flagged row must
    // not keep claiming a deduction on material. A goods article with a grön
    // teknik installation type does pre-fill it: grön teknik is given on
    // arbete och material. Proformas/delivery notes/self-billing have no
    // deduction model (their rows keep no ⋮ menu either), so they are left
    // untouched. A known business customer gets no deduction at all: it
    // is the buyer's skattereduktion, and only a private person has one.
    if (isInvoiceDoc) {
      const prefill = articleDeductionPrefill(a)
      const canClaim = !selectedCustomer || deductionsAvailable
      const kind = canClaim ? prefill.deductionType : null
      const workType = canClaim ? prefill.workType : null
      const currentWorkType = getValues(`items.${index}.work_type`) ?? null
      const keepCurrentWorkType =
        kind != null && !workType && deductionTypeForWorkType(currentWorkType) === kind
      setValue(`items.${index}.deduction_type`, kind, { shouldDirty: true })
      setValue(
        `items.${index}.work_type`,
        workType ?? (keepCurrentWorkType ? currentWorkType : null),
        { shouldDirty: true },
      )
      if (kind) {
        // Same rule as the manual ⋮ menu: ROT/RUT och periodisering
        // kombineras aldrig på samma rad; avdraget vinner.
        if (getValues(`items.${index}.accrual_balance_account`) != null) {
          setValue(`items.${index}.accrual_period_start`, null)
          setValue(`items.${index}.accrual_period_end`, null)
          setValue(`items.${index}.accrual_balance_account`, null)
        }
        seedLaborHours(index)
      } else {
        setValue(`items.${index}.labor_hours`, null)
        setValue(`items.${index}.housing_designation`, null)
        setValue(`items.${index}.apartment_number`, null)
      }
    }
    // Pre-fill the invoice's (single) currency from the article ONLY on the
    // first priced line, and only while the user hasn't chosen a currency
    // themselves. Never flip an in-progress invoice's currency on a later pick:
    // an invoice carries one currency for all its lines, so overwriting it would
    // relabel existing line amounts (or the user's explicit choice) as another
    // currency with no FX conversion, producing a legally wrong faktura and
    // wrong VAT (ML 17 kap). The article's currency comes from the currencies
    // reference table.
    const currencyUserSet = Boolean(dirtyFields.currency)
    const invoiceHasOtherContent = (watchItems ?? []).some(
      (it, i) => i !== index && (Boolean(it?.article_id) || Number(it?.unit_price) > 0)
    )
    if (
      a.currency &&
      currencies.includes(a.currency as Currency) &&
      a.currency !== getValues('currency') &&
      !currencyUserSet &&
      !invoiceHasOtherContent
    ) {
      setValue('currency', a.currency as Currency, { shouldDirty: true })
    }
  }

  // A row's skattereduktion, from its Avdrag cell. The arbetstyp lists are
  // per kind: a ROT code must not survive a switch to RUT (the select would
  // show it as empty while the payload kept the wrong code). ROT/RUT och
  // periodisering kombineras aldrig på samma rad: avdraget vinner.
  function setRowDeduction(index: number, next: DeductionType | null) {
    const item = getValues(`items.${index}`)
    setValue(`items.${index}.deduction_type`, next, { shouldDirty: true })
    if (next !== null && deductionTypeForWorkType(item?.work_type) !== next) {
      // Grön teknik starts on the installation type the invoice already uses.
      setValue(
        `items.${index}.work_type`,
        next === 'gron_teknik' ? defaultGronTeknikWorkType(watchItems, index) : null,
      )
    }
    if (next === null) {
      setValue(`items.${index}.work_type`, null)
      setValue(`items.${index}.labor_hours`, null)
      setValue(`items.${index}.housing_designation`, null)
      setValue(`items.${index}.apartment_number`, null)
      const id = fields[index]?.id
      if (id) autoHoursRef.current.delete(id)
      return
    }
    if (item?.accrual_balance_account != null) {
      setValue(`items.${index}.accrual_period_start`, null)
      setValue(`items.${index}.accrual_period_end`, null)
      setValue(`items.${index}.accrual_balance_account`, null)
    }
    seedLaborHours(index)
  }

  // Arbetstimmar from the row when it is billed by the hour (6 tim = 6
  // hours), and only while the field is empty: a typed value is the user's.
  function seedLaborHours(index: number) {
    const item = getValues(`items.${index}`)
    if (!item || item.labor_hours != null) return
    const hours = defaultLaborHours(item)
    if (hours === null) return
    setValue(`items.${index}.labor_hours`, hours, { shouldDirty: true })
    const id = fields[index]?.id
    if (id) autoHoursRef.current.add(id)
  }

  // A row whose hours were taken from its quantity keeps following it.
  function followQuantity(index: number) {
    const id = fields[index]?.id
    if (!id || !autoHoursRef.current.has(id)) return
    const item = getValues(`items.${index}`)
    if (!item?.deduction_type) return
    const hours = defaultLaborHours(item)
    if (hours !== null) setValue(`items.${index}.labor_hours`, hours, { shouldDirty: true })
  }

  // "Spara som artikel": persist the current free-text line into the register and
  // back-fill the article_id so the row is now catalog-linked.
  async function saveLineAsArticle(index: number) {
    const item = watchItems[index]
    if (!item?.description?.trim()) {
      toast({ title: t('save_article_need_description'), variant: 'destructive' })
      return
    }
    setSavingArticleIndex(index)
    try {
      const response = await fetch('/api/articles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: item.description.trim(),
          unit: item.unit || 'st',
          price_excl_vat: Number(item.unit_price) || 0,
          vat_rate: item.vat_rate ?? 25,
          // The typed unit price is in the invoice's currency: without this an
          // EUR invoice line becomes an SEK article with the EUR number.
          currency: getValues('currency'),
          // Round-trip the deduction flag so the saved article pre-fills the
          // deduction the next time it is picked: the arbetstypskod when the
          // row has one, otherwise the bare kind (ROT/RUT only: grön teknik
          // has no bare kind, its rate needs the installation type).
          housework_type: item.deduction_type
            ? deductionTypeForWorkType(item.work_type) === item.deduction_type
              ? item.work_type
              : item.deduction_type === 'gron_teknik'
                ? null
                : item.deduction_type.toUpperCase()
            : null,
        }),
      })
      const result = await response.json()
      if (!response.ok) {
        throw new Error(getErrorMessage(result, { context: 'article', statusCode: response.status }))
      }
      const created = result.data as ArticleOption
      // Every article picker on the page reads the shared cache: refresh it
      // (awaited, so the new option resolves before the line points at it).
      await invalidateReferenceData('ref:articles')
      setValue(`items.${index}.article_id`, created.id, { shouldDirty: true })
      toast({ title: t('article_saved_title'), description: created.name })
    } catch (error) {
      toast({
        title: t('save_article_failed'),
        description: getErrorMessage(error, { context: 'article' }),
        variant: 'destructive',
      })
    } finally {
      setSavingArticleIndex(null)
    }
  }

  // ---------------------------------------------------------------------
  // Unified entry row: one input in the table's ghost last row. Typing
  // searches the artikelregister; Enter on a highlighted match commits an
  // article line (same side effects as picking the article on a row), Enter
  // on free text commits a free-text product line and moves focus to its
  // price cell. The entry row is never part of the field array until
  // committed, so sort_order and the index-keyed override sets stay stable.
  // ---------------------------------------------------------------------

  // Byte-identical to the previous "Lägg till rad" append defaults: the
  // DEFAULT VAT rate, never the widest permitted one (0% for a
  // reverse-charge / export customer, 25% domestically).
  function appendProductRow(description: string) {
    append({
      line_type: 'product',
      description,
      quantity: 1,
      unit: 'st',
      unit_price: 0,
      discount_percent: null,
      vat_rate: vatRegistered ? vatRatePlan.defaultRate : 0,
      article_id: null,
      sales_order_item_id: null,
      revenue_account: null,
      deduction_type: null,
      labor_hours: null,
      work_type: null,
      housing_designation: null,
      apartment_number: null,
      brf_org_number: null,
      accrual_period_start: null,
      accrual_period_end: null,
      accrual_balance_account: null,
      dimensions: null,
    })
  }

  function commitEntryArticle(articleId: string) {
    const index = fields.length
    appendProductRow('')
    // applyArticle drives the exact same side effects as picking the article
    // on an existing row: description/unit/price, conditional VAT adoption,
    // revenue-account override, ROT/RUT work type, first-line currency.
    applyArticle(index, articleId)
    setEntryQuery('')
    setEntryOpen(false)
    setEntryActiveIdx(-1)
    markRowSettled(index)
    entryInputRef.current?.focus()
  }

  function commitEntryFreeText(text: string) {
    // Enter or Tab commits and the caret lands in the new row's à-pris cell
    // with the 0 selected.
    commitEntryToCell(text, 'unit_price')
  }

  // Commit the entry row and put focus in one cell of the row it became. The
  // ghost cells route here on click (issue #2481): a mouse user starts in the
  // amount, quantity, unit or VAT cell of a row that does not exist yet, so
  // the click births the row (description as typed, possibly empty) and
  // lands in the same cell. The inputs mount on the next commit, hence the
  // timeout; the VAT Select trigger is not a registered field, so it is
  // reached through the data-cell anchor instead of setFocus.
  function commitEntryToCell(text: string, cell: EntryGhostCell) {
    const index = fields.length
    appendProductRow(text)
    setEntryQuery('')
    setEntryOpen(false)
    setEntryActiveIdx(-1)
    markRowSettled(index)
    window.setTimeout(() => {
      if (cell === 'quantity' || cell === 'unit_price' || cell === 'unit') {
        setFocus(`items.${index}.${cell}`, { shouldSelect: true })
        return
      }
      const trigger = document.querySelector<HTMLElement>(
        `#invoice-editor-row-${index} [data-cell="${cell}"]`,
      )
      trigger?.focus()
    }, 0)
  }

  // Free-text / blank row: explanatory text under an item, or an empty
  // spacer. Carries no amounts and never books. Not offered for a received
  // självfaktura (the self-billed endpoint has no line_type and rejects
  // zero-amount rows).
  function addTextRow() {
    const index = fields.length
    append({
      line_type: 'text',
      description: '',
      quantity: 0,
      unit: '',
      unit_price: 0,
      discount_percent: null,
      vat_rate: 0,
      article_id: null,
      sales_order_item_id: null,
      revenue_account: null,
      deduction_type: null,
      labor_hours: null,
      work_type: null,
      housing_designation: null,
      apartment_number: null,
      brf_org_number: null,
      accrual_period_start: null,
      accrual_period_end: null,
      accrual_balance_account: null,
      dimensions: null,
    })
    markRowSettled(index)
    window.setTimeout(() => setFocus(`items.${index}.description`), 0)
  }

  // Brief background settle on a freshly committed row; the CSS animation
  // (globals.css .row-settle) collapses under prefers-reduced-motion. The
  // timeout clears the class even if animationend never fires.
  function markRowSettled(index: number) {
    setSettleIndex(index)
    window.setTimeout(() => {
      setSettleIndex((current) => (current === index ? null : current))
    }, 800)
  }

  // Commit the entry row the way a resolved key action says to. Shared by the
  // keyboard handlers and the "Lägg till rad" button so there is one rule for
  // what a commit means, whatever triggered it.
  function runEntryAction(action: EntryKeyAction, matches: ArticleOption[]) {
    if (action.kind === 'article') commitEntryArticle(matches[action.index].id)
    else if (action.kind === 'free_text') commitEntryFreeText(action.text)
  }

  function handleEntryKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    // An open IME composition (Gboard autocorrect on Android) reports every
    // keydown as keyCode 229 / 'Unidentified', the action key included:
    // acting on one would commit the pre-correction text, and arrowing would
    // fight the candidate list. The keyup below picks the press back up once
    // the composition has ended (issue #2447).
    if (isComposingKey(e.nativeEvent)) {
      entryComposingKeyRef.current = true
      return
    }
    entryComposingKeyRef.current = false
    const matches = filterArticleSuggestions(articles, entryQuery)
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (!entryOpen) setEntryOpen(true)
      if (matches.length) setEntryActiveIdx((i) => Math.min(i + 1, matches.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setEntryActiveIdx((i) => Math.max(i - 1, -1))
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      // Tab commits like Enter (issue #2481): before, it left the typed text
      // stranded in the entry row and submit failed on "at least one row".
      // An empty Tab passes through so the row is not a focus trap; an empty
      // Enter is swallowed so it never submits the form.
      const action = resolveEntryKey({
        key: e.key,
        shiftKey: e.shiftKey,
        query: entryQuery,
        open: entryOpen,
        activeIdx: entryActiveIdx,
        matchCount: matches.length,
      })
      if (e.key === 'Enter' || action.kind !== 'none') e.preventDefault()
      runEntryAction(action, matches)
    } else if (e.key === 'Escape') {
      // Close only the suggestions; the host dialog ignores Escape anyway.
      e.stopPropagation()
      setEntryOpen(false)
      setEntryActiveIdx(-1)
    }
  }

  // The other half of the IME handling: Android delivers the action key as a
  // composing keydown, then compositionend (which flushes the corrected text
  // into entryQuery), then a keyup carrying the real key. That keyup is the
  // only honest chance to act on the press, and only right after a keydown we
  // swallowed, so a desktop Enter can never commit twice.
  function handleEntryKeyUp(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!entryComposingKeyRef.current) return
    entryComposingKeyRef.current = false
    if (e.key !== 'Enter' || isComposingKey(e.nativeEvent)) return
    const matches = filterArticleSuggestions(articles, entryQuery)
    runEntryAction(
      resolveEntryKey({
        key: 'Enter',
        query: entryQuery,
        open: entryOpen,
        activeIdx: entryActiveIdx,
        matchCount: matches.length,
      }),
      matches,
    )
  }

  // Keyboard-free commit (issue #2447): a touch keyboard has no Tab, and an
  // IME can swallow Enter, so the entry row also needs a visible button. Same
  // rule as Enter, down to a highlighted suggestion winning; with nothing
  // typed it adds a blank product row, which is what the explicit add-row
  // button did before the entry row replaced it.
  function addEntryRow() {
    const matches = filterArticleSuggestions(articles, entryQuery)
    const action = resolveEntryKey({
      key: 'Enter',
      query: entryQuery,
      open: entryOpen,
      activeIdx: entryActiveIdx,
      matchCount: matches.length,
    })
    if (action.kind !== 'none') {
      runEntryAction(action, matches)
      return
    }
    // Nothing typed: add the blank product row and start in its description,
    // the same landing addTextRow gives.
    const index = fields.length
    appendProductRow('')
    setEntryQuery('')
    setEntryOpen(false)
    setEntryActiveIdx(-1)
    markRowSettled(index)
    window.setTimeout(() => setFocus(`items.${index}.description`), 0)
  }

  // Open/close the per-row article re-link strip (row ⋮ menu). Closing never
  // clears the article link: unlike the account override, the link is data on
  // the row; detaching goes through the strip's "Egen rad" option instead.
  function toggleArticlePicker(index: number) {
    setArticlePickerRows((prev) => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  // Apply the company settings ONCE per editor instance. The settings row is
  // a live SWR value: a background revalidation must not re-run the
  // create-mode prefills below over notes or a reference the user has since
  // typed. The gates read each time (vatRegistered, dimensions, payment
  // links) are cheap and deliberately re-applied too, they are not user input.
  const settingsAppliedRef = useRef(false)
  useEffect(() => {
    const data = companySettings
    if (!data || settingsAppliedRef.current) return
    settingsAppliedRef.current = true
    if (data?.invoice_default_notes) {
      setDefaultNotes(data.invoice_default_notes)
      if (!isEditMode && !isCopyMode) {
        setValue('notes', data.invoice_default_notes)
      }
    }
    // Pre-fill "Vår referens" from the company default: only when creating a
    // fresh invoice, so an edited draft's own reference is never overwritten.
    if (!isEditMode && !isCopyMode && data?.default_our_reference) {
      setValue('our_reference', data.default_our_reference)
    }
    if (data?.accounting_method === 'cash' || data?.accounting_method === 'accrual') {
      setAccountingMethod(data.accounting_method)
    }
    // An explicit per-invoice flag (edit mode) wins; only fall back to the
    // company-wide setting when creating or when the draft never set one.
    if (typeof data?.ore_rounding === 'boolean' && initialOreRounding == null) {
      setOreRounding(data.ore_rounding)
    }
    setLogoUrl(data?.logo_url ?? null)
    if (typeof data?.vat_registered === 'boolean') {
      setVatRegistered(data.vat_registered)
    }
    // Gates the dimension affordances (header default + per-row override).
    setDimensionsEnabled(data?.dimensions_enabled === true)
    // Gates the payment-link section (opt-in on the invoice settings page).
    setPaymentLinksEnabled(data?.invoice_payment_links_enabled === true)
  // The initial-mode flags and the draft's own rounding are fixed for the
  // editor's lifetime; setValue is stable (react-hook-form).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companySettings])

  // First-invoice detection (issue #520): captured at page load so the
  // post-create flow can offer the logo prompt for genuinely first-time
  // invoices only. head:true keeps it cheap: no rows pulled.
  useEffect(() => {
    if (!company?.id) return
    let cancelled = false
    ;(async () => {
      const { count } = await supabase
        .from('invoices')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', company.id)
      if (!cancelled) setHadZeroInvoices(count === 0 || count === null)
    })()
    return () => {
      cancelled = true
    }
    // supabase is a stable reference from createClient() at top of component
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company?.id])

  // Preview the next invoice number so the user can catch a mis-set
  // sequence/prefix before committing. The actual allocator still runs
  // atomically at create time; this is read-only.
  useEffect(() => {
    if (!company?.id) return
    // A draft that already has its number keeps it: no "next number"
    // preview. An unnumbered draft (Spara som utkast) gets one at send.
    if ((isEditMode && initial?.invoice_number) || watchDocumentType === 'delivery_note') {
      setNumberPreview(null)
      return
    }
    let cancelled = false
    fetch(`/api/invoices/next-number?document_type=${encodeURIComponent(watchDocumentType)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((res) => {
        if (!cancelled) setNumberPreview(res?.data?.preview ?? null)
      })
      .catch(() => {
        if (!cancelled) setNumberPreview(null)
      })
    return () => {
      cancelled = true
    }
  }, [company?.id, watchDocumentType, isEditMode, initial?.invoice_number])

  useEffect(() => {
    if (watchCustomerId) {
      const customer = customers.find((c) => c.id === watchCustomerId)
      setSelectedCustomer(customer || null)

      // Skip the derived side-effects (due_date, VAT rate snap) the first time
      // we resolve a pre-filled customer in edit mode: those values came from
      // the saved draft and must not be overwritten. Applied normally on every
      // subsequent (user-initiated) customer change, and always in create mode.
      if (customer) {
        const nextDefaultRate = resolveLineVatRates(customer).defaultRate
        if (didInitialCustomerSync.current) {
          // Update due date based on customer payment terms, counted from the
          // invoice date the form is actually on: picking a customer after
          // setting fakturadatum to the 31st must give the 31st + terms, not
          // today + terms. This fill is the second writer of due_date, and the
          // only one that knows a term the date pair cannot show (fakturadatum
          // may be empty here), so it hands that term to the sync baseline.
          if (customer.default_payment_terms) {
            const fill = planCustomerTermsFill({
              invoiceDate: getValues('invoice_date') || '',
              terms: customer.default_payment_terms,
              today: format(new Date(), 'yyyy-MM-dd'),
            })
            setValue('due_date', fill.dueDate)
            dueDateSyncRef.current = { ...dueDateSyncRef.current, terms: fill.terms }
          }

          // Move only the lines still sitting on the OLD customer's default
          // rate onto the new one: the switch must not leave a stale 25% on a
          // reverse-charge invoice, nor a stale 0% on a domestic one. A line
          // the user moved off that default stays put: 12% on a Stockholm
          // hotel night sold to a German company is lawful (taxed where
          // performed, ML 6 kap.) and snapping it to 0% would destroy it.
          if (didSeedVatSnapBaseline.current) {
            for (const snap of planCustomerSwitchVatSnap({
              items: watchItems ?? [],
              previousDefaultRate: previousDefaultRateRef.current,
              nextDefaultRate,
            })) {
              setValue(`items.${snap.index}.vat_rate`, snap.rate)
            }
          }
        }
        previousDefaultRateRef.current = nextDefaultRate
        didSeedVatSnapBaseline.current = true
        didInitialCustomerSync.current = true
      }
    }
  }, [watchCustomerId, customers, setValue, getValues])

  // One-click VIES check from the draft (#2749). /api/vat/validate has
  // already stamped the customer row; mirror it on the local copy so the
  // rate plan flips to reverse charge, and move the lines still sitting on
  // the old default (25 %) onto the new one (0 %) exactly like a customer
  // switch: a rate the user set deliberately stays put. The review snapshot
  // (pendingData) gets the same snaps so a confirm from inside the dialog
  // posts the corrected lines. The session cache is left alone on purpose:
  // a refreshed customers list re-runs the sync effect above, which also
  // resets due_date, and that must not happen under an open edit. SWR
  // revalidates it on its own schedule with the server value.
  function handleCustomerVatValidated(result: { vat_number: string }) {
    if (!selectedCustomer) return
    const validatedCustomer: Customer = {
      ...selectedCustomer,
      vat_number: result.vat_number,
      vat_number_validated: true,
      vat_number_validated_at: new Date().toISOString(),
    }
    const nextDefaultRate = resolveLineVatRates(validatedCustomer).defaultRate
    const snaps = planCustomerSwitchVatSnap({
      items: watchItems ?? [],
      previousDefaultRate: previousDefaultRateRef.current,
      nextDefaultRate,
    })
    for (const snap of snaps) {
      setValue(`items.${snap.index}.vat_rate`, snap.rate, { shouldDirty: true })
    }
    if (snaps.length > 0) {
      setPendingData((prev) =>
        prev
          ? {
              ...prev,
              items: prev.items.map((item, index) => {
                const snap = snaps.find((candidate) => candidate.index === index)
                return snap ? { ...item, vat_rate: snap.rate } : item
              }),
            }
          : prev,
      )
    }
    previousDefaultRateRef.current = nextDefaultRate
    setSelectedCustomer(validatedCustomer)
  }

  async function handleCreateCustomer(data: CreateCustomerInput) {
    setIsCreatingCustomer(true)

    const response = await fetch('/api/customers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })

    const result = await response.json()

    if (!response.ok) {
      toast({
        title: t('create_customer_failed_title'),
        description: getErrorMessage(result, { context: 'customer' }),
        variant: 'destructive',
      })
    } else {
      toast({
        title: t('customer_created_title'),
        description: t('customer_created_description', { name: data.name }),
      })
      pendingCustomerRef.current = result.data
      // The selection effect above picks the pending customer up as soon as
      // the refreshed shared list contains it.
      await invalidateReferenceData('ref:customers')
      setIsCreateCustomerOpen(false)
    }

    setIsCreatingCustomer(false)
  }

  const subtotal = watchItems.reduce((sum, item) => {
    return sum + computeLineNet(item.quantity || 0, item.unit_price || 0, item.discount_percent)
  }, 0)

  const vatRules = selectedCustomer
    ? getVatRules(selectedCustomer.customer_type, selectedCustomer.vat_number_validated, selectedCustomer.country)
    : null

  // Rendered options and the default are deliberately two different sets:
  // `options` is what may LAWFULLY appear on a line (getPermittedVatRates),
  // `defaultRates` / `defaultRate` is what the form OFFERS by itself
  // (getAvailableVatRates). See components/invoices/line-vat-rates.ts.
  const vatRatePlan = resolveLineVatRates(selectedCustomer)
  // Effective rates of the priced lines, as the server will store them: an
  // absent rate falls back to the customer default (build-invoice-write).
  // Empty for a non-momsregistrerad seller, who charges nothing.
  const effectiveLineVatRates = vatRegistered
    ? (watchItems ?? [])
        .filter((item) => item?.line_type !== 'text')
        .map((item) => item?.vat_rate ?? vatRatePlan.defaultRate)
    : []
  // Why the treatment is what it is (#2749, #2558): the same sentence the
  // draft page, the MCP approval card and the API responses carry. Empty
  // when there is nothing to explain. Swedish VAT to an EU customer whose
  // reverse charge is blocked needs an explicit confirm before creation.
  const vatWarnings =
    selectedCustomer && vatRegistered ? explainVatTreatment(selectedCustomer, effectiveLineVatRates) : []
  const needsSwedishVatAcknowledgement = requiresSwedishVatAcknowledgement(vatWarnings, effectiveLineVatRates)
  // A non-momsregistrerad company never charges VAT: hide the Moms column and
  // book every line momsfritt. `vatRegistered` is the single switch the whole
  // form keys off: no rate picker, no warning, no VAT in the totals/preview.
  // The API enforces the same (forces 0% server-side), so a stale hidden field
  // value can't smuggle VAT onto the invoice.
  // The Moms column itself shows only when a row's rate differs from the
  // customer's default (lib/invoices/editor/rows.ts); otherwise the row menu
  // changes a rate and Summering shows the VAT.
  const showVatColumn = shouldShowVatColumn({
    vatRegistered,
    defaultRate: vatRatePlan.defaultRate,
    rates: (watchItems ?? []).filter((item) => item?.line_type !== 'text').map((item) => item?.vat_rate),
  })

  // Calculate per-item VAT. When not VAT-registered every rate is forced to 0
  // so vatAmount stays 0 and total === subtotal.
  const vatByRate = new Map<number, { base: number; vat: number }>()
  let vatAmount = 0
  for (const item of watchItems) {
    const rate = vatRegistered ? (item.vat_rate ?? (vatRules?.rate || 25)) : 0
    const lineTotal = computeLineNet(item.quantity || 0, item.unit_price || 0, item.discount_percent)
    const lineVat = Math.round(lineTotal * rate / 100 * 100) / 100
    vatAmount += lineVat
    const existing = vatByRate.get(rate) || { base: 0, vat: 0 }
    existing.base += lineTotal
    existing.vat += lineVat
    vatByRate.set(rate, existing)
  }
  const total = subtotal + vatAmount

  // ROT/RUT-avdrag live preview. Computed client-side for instant feedback;
  // the API recomputes server-side as the source of truth. Skipped for
  // non-invoice document types (proformas and delivery notes don't book
  // a deduction).
  const isSelfBilled = mode === 'self_billed'
  // ROT/RUT is an own-issued, B2C concept: never shown for a received self-bill.
  const isInvoiceDoc = watchDocumentType === 'invoice' && !isSelfBilled
  // Offert: no due date (an expiry instead), no payment box, never books.
  const isQuoteDoc = watchDocumentType === 'quote' && !isSelfBilled
  rotRutCompletenessAppliesRef.current = isInvoiceDoc
  // ROT, RUT and grön teknik are a private person's: the Avdrag column is
  // there for one, or for a row that already claims a deduction (an older
  // draft) so it can be seen and removed.
  const deductionsAvailable = resolveDeductionsAvailable({
    isInvoiceDoc,
    customerType: selectedCustomer?.customer_type,
  })
  const showDeductionColumn =
    isInvoiceDoc && shouldShowDeductionColumn({ available: deductionsAvailable, items: watchItems ?? [] })
  const extraColumns = (showVatColumn ? 1 : 0) + (showDeductionColumn ? 1 : 0)
  const rowGridClass =
    extraColumns === 2 ? ROW_GRID_TWO_EXTRA : extraColumns === 1 ? ROW_GRID_ONE_EXTRA : ROW_GRID_BASE

  // ROT/RUT yearly-ceiling context: what this customer has already been
  // granted in the invoice's calendar year (SEK), across issued invoices with
  // a deduction. Per customer, not per personnummer (the number is only ever
  // ciphertext here), and blind to other providers, so it feeds a warning,
  // never a block: the customer still owns their remaining headroom.
  const [priorYearDeductions, setPriorYearDeductions] = useState<PriorYearDeductions | null>(null)
  const invoiceYear = (watchInvoiceDate || '').slice(0, 4)
  useEffect(() => {
    if (!isInvoiceDoc || !company?.id || !watchCustomerId || !isFiscalYear(invoiceYear)) {
      setPriorYearDeductions(null)
      return
    }
    let cancelled = false
    // The ceiling follows the year the buyer PAID (Skatteverket attributes the
    // skattereduktion to the payment year), so paid invoices count by paid_at
    // and open ones by invoice_date. A customer has few deduction invoices, so
    // fetch them all (paginated: PostgREST caps plain selects) and pick the
    // year here rather than through a runtime-built OR filter.
    fetchAllRows<{
      id: string
      currency: string | null
      exchange_rate: number | null
      paid_at: string | null
      invoice_date: string
      invoice_items: Array<{ deduction_type: DeductionType | null; deduction_amount: number | null }> | null
    }>(({ from, to }) =>
      supabase
        .from('invoices')
        .select('id, currency, exchange_rate, paid_at, invoice_date, invoice_items(deduction_type, deduction_amount)')
        .eq('company_id', company.id)
        .eq('customer_id', watchCustomerId)
        .eq('document_type', 'invoice')
        .is('credited_invoice_id', null)
        .not('status', 'in', '(draft,cancelled,credited)')
        .gt('deduction_total', 0)
        .order('id')
        .range(from, to),
    )
      .then((data) => {
        if (cancelled) return
        // Grön teknik has its own ceiling: its own bucket, never ROT/RUT's.
        const totals: Required<PriorYearDeductions> = { rot: 0, rut: 0, gron_teknik: 0 }
        for (const inv of data) {
          if (initial?.id && inv.id === initial.id) continue
          if ((inv.paid_at ?? inv.invoice_date ?? '').slice(0, 4) !== invoiceYear) continue
          const isSek = !inv.currency || inv.currency === 'SEK'
          const rate = inv.exchange_rate
          if (!isSek && !(typeof rate === 'number' && rate > 0)) continue
          for (const it of inv.invoice_items ?? []) {
            if (!it.deduction_type || !it.deduction_amount) continue
            const sek = isSek ? it.deduction_amount : it.deduction_amount * (rate as number)
            if (!(it.deduction_type in totals)) continue
            totals[it.deduction_type] += roundOre(sek)
          }
        }
        setPriorYearDeductions(totals)
      })
      .catch(() => {
        // A failed lookup must not leave a stale total from another customer or
        // year on screen; no prior context = per-invoice check only.
        if (!cancelled) setPriorYearDeductions(null)
      })
    return () => {
      cancelled = true
    }
    // supabase client is stable; initial?.id only changes with the invoice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isInvoiceDoc, company?.id, watchCustomerId, invoiceYear, initial?.id])
  const deductionByKind = { rot: 0, rut: 0, gron_teknik: 0 }
  if (isInvoiceDoc) {
    for (const item of watchItems) {
      if (!item.deduction_type) continue
      const amount = computeDeduction({
        unit_price: item.unit_price || 0,
        quantity: item.quantity || 0,
        discount_percent: item.discount_percent,
        deduction_type: item.deduction_type,
        // Grön teknik's rate follows the installation type.
        work_type: item.work_type,
        // Same rate resolution as the VAT totals loop above: the deduction
        // base is the line total inkl. moms (HUSFL 6-9 §§).
        vat_rate: vatRegistered ? (item.vat_rate ?? (vatRules?.rate || 25)) : 0,
      })
      if (item.deduction_type === 'rot') deductionByKind.rot += amount
      else if (item.deduction_type === 'gron_teknik') deductionByKind.gron_teknik += amount
      else deductionByKind.rut += amount
    }
  }
  // (x + 0 is exact, so a ROT/RUT-only form sums exactly as before.)
  const deductionTotal =
    Math.round((deductionByKind.rot + deductionByKind.rut + deductionByKind.gron_teknik) * 100) / 100
  // Same helper as the server validator (validateInvoice → deductionCapWarnings):
  // per-kind and shared yearly ceilings, on top of what this customer already
  // has this year. Statutory Swedish text (Skatteverket wording, stays Swedish
  // in both locales like the server warnings it mirrors).
  const capWarnings = isInvoiceDoc && deductionTotal > 0
    ? deductionCapWarnings(deductionByKind, { currency: watchCurrency }, priorYearDeductions)
    : []
  // Any flagged row, not only rows with a positive amount yet: the payload
  // sanitizer and the server both key on deduction_type, so the card (with
  // the personnummer the server will demand) must appear on the same predicate.
  const hasAnyDeduction = deductionTotal > 0 || (isInvoiceDoc && watchItems.some((i) => Boolean(i.deduction_type)))
  const hasAnyRotLine = isInvoiceDoc && watchItems.some((i) => i.deduction_type === 'rot')
  // Grön teknik names the property like ROT does, and never shares the
  // invoice with ROT/RUT (the form refuses the mix).
  const hasAnyGronTeknikLine = isInvoiceDoc && watchItems.some((i) => i.deduction_type === 'gron_teknik')
  // The kundkort's personnummer reaches this component as ciphertext (direct
  // table read) or as the masked display form (rows from the API), so the
  // editor can only know THAT the customer has one, never render it. Presence
  // is enough: the server falls back to it when the field is left empty, so
  // the field stops being required and the hint says where the number will
  // come from. The undecryptable placeholder is not presence.
  const customerHasPersonalNumber = Boolean(
    selectedCustomer?.personal_number &&
      selectedCustomer.personal_number !== UNDECRYPTABLE_PERSONAL_NUMBER_MASK,
  )

  // Öresavrundning live preview: same helper as the PDF/email, so the summary
  // shows exactly what the customer will see. Display-only; the saved invoice
  // keeps the exact öre.
  const { rounding: displayRounding, toPay: displayedToPay } = getAmountToPay(
    { total, currency: watchCurrency, ore_rounding: oreRounding, deduction_total: deductionTotal },
    null,
  )

  // Periodisering per rad: kräver faktureringsmetoden och en riktig faktura.
  // EU-/exportkunder bokas på 3308/3305 (omvänd skattskyldighet/export) och
  // kan inte periodiseras: ruta 39/40 ska spegla hela försäljningen.
  const customerBlocksAccrual =
    selectedCustomer?.customer_type === 'eu_business' ||
    selectedCustomer?.customer_type === 'non_eu_business'
  const canUseAccrual = isInvoiceDoc && accountingMethod === 'accrual' && !customerBlocksAccrual

  function toggleAccrual(index: number) {
    if (watchItems[index]?.accrual_balance_account != null) {
      setValue(`items.${index}.accrual_period_start`, null, { shouldDirty: true })
      setValue(`items.${index}.accrual_period_end`, null, { shouldDirty: true })
      setValue(`items.${index}.accrual_balance_account`, null, { shouldDirty: true })
      setAccrualRows((prev) => {
        const next = new Set(prev)
        next.delete(index)
        return next
      })
    } else {
      setAccrualRows((prev) => new Set(prev).add(index))
      setValue(`items.${index}.accrual_period_start`, watch('invoice_date') || '', { shouldDirty: true })
      setValue(`items.${index}.accrual_period_end`, '', { shouldDirty: true })
      setValue(
        `items.${index}.accrual_balance_account`,
        DEFAULT_DEFERRED_REVENUE_ACCOUNT,
        { shouldDirty: true },
      )
    }
  }

  // A row badge folds its option's strip open or shut; unlike the row menu
  // it never clears the value.
  function toggleStripOpen(
    setRows: React.Dispatch<React.SetStateAction<Set<number>>>,
    index: number,
  ) {
    setRows((prev) => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  // Open/close the optional per-line posting-account override. Closing clears
  // the value so the engine falls back to the VAT-rate-derived revenue account.
  function toggleAccountOverride(index: number) {
    const isOpen = accountOverrideRows.has(index) || !!watchItems[index]?.revenue_account
    if (isOpen) {
      setValue(`items.${index}.revenue_account`, null, { shouldDirty: true })
      setAccountOverrideRows((prev) => {
        const next = new Set(prev)
        next.delete(index)
        return next
      })
    } else {
      setAccountOverrideRows((prev) => new Set(prev).add(index))
    }
  }

  // Open/close the per-line discount (⋮ menu). Closing clears the value so
  // the row books at full price again.
  function toggleDiscount(index: number) {
    const isOpen = discountRows.has(index) || hasLineDiscount(watchItems[index]?.discount_percent)
    if (isOpen) {
      setValue(`items.${index}.discount_percent`, null, { shouldDirty: true, shouldValidate: true })
      setDiscountRows((prev) => {
        const next = new Set(prev)
        next.delete(index)
        return next
      })
    } else {
      setDiscountRows((prev) => new Set(prev).add(index))
      window.setTimeout(() => setFocus(`items.${index}.discount_percent`), 0)
    }
  }

  // Open/close the optional per-item dimensions override (⋮ menu). Closing
  // clears the bag so the row falls back to the invoice's default_dimensions.
  function toggleItemDimensions(index: number) {
    const isOpen = dimensionOverrideRows.has(index) || hasDimensionValues(watchItems[index]?.dimensions)
    if (isOpen) {
      setValue(`items.${index}.dimensions`, null, { shouldDirty: true })
      setDimensionOverrideRows((prev) => {
        const next = new Set(prev)
        next.delete(index)
        return next
      })
    } else {
      setDimensionOverrideRows((prev) => new Set(prev).add(index))
    }
  }

  function updateItemDimension(index: number, dimNo: string, code: string | null) {
    const current = { ...(watchItems[index]?.dimensions ?? {}) }
    const trimmed = code?.trim()
    if (trimmed) current[dimNo] = trimmed
    else delete current[dimNo]
    setValue(
      `items.${index}.dimensions`,
      Object.keys(current).length > 0 ? current : null,
      { shouldDirty: true },
    )
    // Keep the sub-row open after the user clears the last value: it closes
    // only via the ⋮ menu (same lifecycle as the account override).
    setDimensionOverrideRows((prev) => (prev.has(index) ? prev : new Set(prev).add(index)))
  }

  function setDefaultDimension(dimNo: string, code: string | null) {
    setDefaultDims((prev) => {
      const next = { ...prev }
      const trimmed = code?.trim()
      if (trimmed) next[dimNo] = trimmed
      else delete next[dimNo]
      return next
    })
  }

  // Self-billing path: no review dialog, no PDF, no send: it arrives already
  // booked. POST straight to the dedicated endpoint and open the verifikat.
  // Body mapping lives in lib/invoices/editor-payload.ts (payload-parity
  // tested), together with the shared create/draft/edit body builder.
  async function handleSelfBilledSubmit(data: FormData) {
    setIsSubmitting(true)
    try {
      const response = await fetch('/api/invoices/self-billed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildSelfBilledPayload(data)),
      })
      const result = await response.json()
      if (!response.ok) {
        throw new Error(getErrorMessage(result, { context: 'invoice', statusCode: response.status }))
      }
      toast({
        title: ts('created_title'),
        description: ts('created_description', { number: data.external_invoice_number ?? '' }),
      })
      router.replace(`/invoices/${result.data.id}`)
    } catch (error) {
      toast({
        title: ts('create_failed_title'),
        description: getErrorMessage(error, { context: 'invoice' }),
        variant: 'destructive',
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  // Mottagen självfaktura: the two self-billing-only fields are optional in
  // the shared schema; enforce them here so the inline errors render under
  // the right inputs.
  async function submitSelfBilled(data: FormData) {
    let valid = true
    if (!data.external_invoice_number?.trim()) {
      setError('external_invoice_number', { message: ts('validation_external_number_required') })
      valid = false
    }
    if (!data.received_date) {
      setError('received_date', { message: ts('validation_received_date_required') })
      valid = false
    }
    if (!valid) return
    await handleSelfBilledSubmit(data)
  }

  // Every editor action starts here: the top-bar primary, its caret menu and
  // Cmd/Ctrl+Enter. The form is validated first; an invalid click moves focus
  // to the first missing field (onInvalidSubmit) instead of reading as dead.
  function requestIntent(intent: EditorIntent) {
    if (inFlight || !canWrite) return
    switch (intent.kind) {
      case 'save_changes':
        void handleSubmit(saveEdit, onInvalidSubmit)()
        return
      case 'save_draft':
        void handleSubmit(saveDraftData, onInvalidSubmit)()
        return
      case 'register_self_billed':
        void handleSubmit(submitSelfBilled, onInvalidSubmit)()
        return
      case 'send':
        // The pick sticks: the primary's face follows the chosen channel.
        if (!isEditMode) setChannelChoice(intent.channel)
        void handleSubmit((data) => prepareConfirm(data, intent), onInvalidSubmit)()
        return
      case 'create':
        void handleSubmit((data) => prepareConfirm(data, intent), onInvalidSubmit)()
        return
    }
  }

  async function prepareConfirm(data: FormData, intent: ConfirmIntent) {
    // A send books on the invoice date: one in a locked or closed period is
    // refused by the database, so the date is the thing to fix first (the
    // status line says why).
    if (intent.kind === 'send' && dateLock && data.document_type === 'invoice') {
      focusSettingsField('invoice_date')
      return
    }
    // The confirm names the customer: a click while the customers list is
    // still loading (or failed to load) must say so rather than do nothing
    // (support: cbysea.se).
    if (!selectedCustomer) {
      toast({
        title: t('review_customer_missing_title'),
        description: t('review_customer_missing_description'),
        variant: 'destructive',
      })
      return
    }
    setPendingData(data)
    // Re-fetch the preview right before the confirm so the displayed number
    // reflects any concurrent invoice creations. Skip for delivery notes and
    // for a draft that already holds its number. Bounded: this blocks the
    // confirm from opening, and a hung fetch must not freeze the flow.
    if (data.document_type !== 'delivery_note' && !(isEditMode && initial?.invoice_number)) {
      try {
        const r = await fetch(
          `/api/invoices/next-number?document_type=${encodeURIComponent(data.document_type)}`,
          { signal: AbortSignal.timeout(5000) },
        )
        if (r.ok) {
          const json = await r.json()
          setNumberPreview(json?.data?.preview ?? null)
        }
      } catch {
        // Preview is best-effort; the allocator at create time is the source of truth.
      }
    }
    continueToConfirm(intent, data.document_type)
  }

  // The gates in front of the confirm, in order: payment details that print
  // for a faktura (added inline in the Betalning section, then the confirm
  // follows), then the one-shot logo prompt on the company's very first
  // invoice (issue #520), so a fresh logo makes it onto the PDF that is sent.
  function continueToConfirm(
    intent: ConfirmIntent,
    documentType: InvoiceDocumentType,
    done: { bank?: boolean; logo?: boolean } = {},
  ) {
    if (!done.bank && paymentSummary?.payeeMissing && documentType === 'invoice') {
      setQueuedIntent(intent)
      openPayeeFix()
      return
    }
    if (!done.logo && !logoPromptDone && !isEditMode && hadZeroInvoices === true && !logoUrl) {
      setQueuedIntent(intent)
      setShowLogoPrompt(true)
      return
    }
    setQueuedIntent(null)
    setConfirmIntent(intent)
  }

  // Missing payment details are fixed where they show, in the Betalning
  // section: the inline form when there are none, the panel when they exist
  // but are hidden. Members are told to ask an administrator there.
  function openPayeeFix() {
    setPane('form')
    if (paymentSummary?.storedAccountUsable && isCompanyAdmin && canWrite) {
      setPaymentPanelScope('all')
      setPaymentPanelOpen(true)
      return
    }
    if (isCompanyAdmin && canWrite) setAddingPayee(true)
    window.setTimeout(() => {
      document.getElementById('invoice-editor-payment')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 0)
  }

  async function handleBankSetupComplete() {
    setAddingPayee(false)
    await refetchCompanySettings()
    setPreviewRefreshKey((key) => key + 1)
    if (queuedIntent && pendingData) {
      continueToConfirm(queuedIntent, pendingData.document_type, { bank: true })
    }
  }

  // A company setting changed in the payment panel: patch the cached row so
  // the summary follows at once, and re-render the preview from the server.
  function handleSettingsSaved(updates: Partial<CompanySettingsRow>) {
    patchCompanySettings(updates)
    setPreviewRefreshKey((key) => key + 1)
  }

  function getDocLabel(type: InvoiceDocumentType): string {
    if (type === 'proforma') return t('doc_label_proforma')
    if (type === 'delivery_note') return t('doc_label_delivery_note')
    if (type === 'quote') return t('doc_label_quote')
    return t('doc_label_invoice')
  }

  function handleLogoPromptClose() {
    setShowLogoPrompt(false)
    setLogoPromptDone(true)
    setPreviewRefreshKey((key) => key + 1)
    if (queuedIntent && pendingData) {
      continueToConfirm(queuedIntent, pendingData.document_type, { bank: true, logo: true })
    }
  }

  // "Skapa utan att skicka": the numbered document, nothing sent (what
  // "Granska & skapa" did). The detail page sends it later.
  async function createWithoutSending() {
    if (!pendingData) return
    setIsSubmitting(true)

    // Shared body builder (lib/invoices/editor-payload.ts): dimension pruning,
    // ROT/RUT privacy strip, self-billing-carrier removal and the always-sent
    // ore_rounding / default_dimensions all live there, pinned by parity tests.
    const sanitizedPayload = buildInvoiceWritePayload(withQuoteValidity(pendingData), {
      oreRounding,
      defaultDims,
    })

    try {
      const response = await fetch('/api/invoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sanitizedPayload),
      })

      const result = await response.json()

      if (!response.ok) {
        throw new Error(getErrorMessage(result, { context: 'invoice', statusCode: response.status }))
      }

      const docLabel = getDocLabel(watchDocumentType)
      toast({
        title: t('doc_created_title', { docLabel }),
        description: t('doc_created_description', { docLabel, number: result.data.invoice_number }),
      })

      setConfirmIntent(null)
      router.replace(`/invoices/${result.data.id}`)
    } catch (error) {
      toast({
        title: t('create_invoice_failed_title'),
        description: getErrorMessage(error, { context: 'invoice' }),
        variant: 'destructive',
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  // Confirm on a send: persist the form (create, or PATCH the draft), then
  // send it or mark it sent (lib/invoices/editor/send-sequence.ts). "Jag
  // skickar själv" lands on the detail page with ?download=1, which downloads
  // the archived, numbered PDF the customer is to get.
  async function sendFromEditor(channel: EditorChannel) {
    if (!pendingData) return
    // Peppol is never offered from the editor yet (no readiness signal before
    // the invoice exists); the detail page sends e-fakturor.
    const route = channel === 'email' ? 'email' : 'manual'
    setIsSubmitting(true)
    const result = await persistAndSend({
      mode: isEditMode ? 'edit' : 'create',
      invoiceId: initial?.id ?? null,
      invoiceNumber: initial?.invoice_number ?? null,
      documentType: pendingData.document_type,
      payload: buildInvoiceWritePayload(withQuoteValidity(pendingData), { oreRounding, defaultDims }),
      channel: route,
      email:
        route === 'email'
          ? {
              additional_cc: isCompanyAdmin ? extraCc : undefined,
              email_subject: emailOverride?.subject,
              email_body: emailOverride?.body,
            }
          : undefined,
    })

    if (!result.ok) {
      const description = getErrorMessage(result.error ?? new Error(`HTTP ${result.status}`), {
        locale,
        context: 'invoice',
        statusCode: result.status || undefined,
      })
      if (result.invoiceId) {
        // The document exists now: a retry from here would create a second
        // one, so the detail page takes over.
        toast({
          title: tShell('toast_saved_not_sent_title'),
          description: tShell('toast_saved_not_sent', { error: description }),
          variant: 'destructive',
        })
        setConfirmIntent(null)
        router.replace(`/invoices/${result.invoiceId}`)
        return
      }
      toast({
        title: isEditMode ? t('update_failed_title') : t('create_invoice_failed_title'),
        description,
        variant: 'destructive',
      })
      setIsSubmitting(false)
      return
    }

    const booked = booksOnIssue && !result.partial
    toast({
      title: tShell(
        route === 'email'
          ? booked ? 'toast_sent_book_title' : 'toast_sent_title'
          : booked ? 'toast_marked_book_title' : 'toast_marked_title',
      ),
      description: result.partial
        ? route === 'email'
          ? tSend('partial_success', { message: result.message ?? tShell('toast_sent_title') })
          : tSend('mark_partial_success')
        : route === 'email'
          ? result.message ?? undefined
          : undefined,
      ...(result.partial ? { variant: 'destructive' as const } : {}),
    })
    setConfirmIntent(null)
    // isSubmitting stays on: the editor is leaving, and a second click must
    // not send twice.
    router.replace(
      route === 'manual' && !result.partial
        ? `/invoices/${result.invoiceId}?download=1`
        : `/invoices/${result.invoiceId}`,
    )
  }

  // A failed Zod validation must never read as a dead button (the primary is
  // enabled pre-click for writable users), so an invalid click routes focus
  // to the first missing field, in the same order as the next-step line,
  // which announces the problem via its aria-live region. Server-side
  // failures keep their toasts: this replaces the client-side validation
  // toast only.
  function focusSettingsField(
    name: 'invoice_date' | 'due_date' | 'valid_until' | 'received_date' | 'payment_link_url' | 'delivery_date' | 'currency',
  ) {
    setPane('form')
    // In self-billed mode fakturadatum and mottagningsdatum render uncollapsed
    // next to the external number: focus directly, no panel to expand.
    if (isSelfBilled && (name === 'invoice_date' || name === 'received_date')) {
      setFocus(name)
      return
    }
    // The payment link is this invoice's own, in the payment panel.
    if (name === 'payment_link_url') {
      setPaymentPanelScope('this')
      setPaymentPanelOpen(true)
      window.setTimeout(() => setFocus(name), 60)
      return
    }
    // The field lives in the folded Detaljer section: open it first, focus
    // once the fields are mounted.
    setPaymentPanelOpen(false)
    setDetailsOpen(true)
    if (name === 'delivery_date') setDeliveryOpen(true)
    window.setTimeout(() => {
      if (name === 'currency') {
        document.querySelector<HTMLElement>('#invoice-editor-details [data-field="currency"]')?.focus()
        return
      }
      setFocus(name)
    }, 60)
  }

  // A Detaljer chip opens the fields at its own field.
  function handleDetailsChip(kind: DetailsChip['kind']) {
    switch (kind) {
      case 'invoice_date':
        focusSettingsField('invoice_date')
        return
      case 'due':
        focusSettingsField('due_date')
        return
      case 'valid_until':
        focusSettingsField('valid_until')
        return
      case 'currency':
        focusSettingsField('currency')
        return
      case 'delivery':
        focusSettingsField('delivery_date')
        return
      case 'language':
        setDetailsOpen(true)
        return
      case 'dimensions':
        setDetailsOpen(true)
        setDefaultDimsOpen(true)
        return
    }
  }

  function scrollRowIntoView(index: number) {
    document
      .getElementById(`invoice-editor-row-${index}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  function focusStep(step: NextStep) {
    switch (step.kind) {
      case 'customer':
        customerTriggerRef.current?.focus()
        break
      case 'invoice_date':
      case 'received_date':
        focusSettingsField(step.kind)
        break
      case 'due_date':
        // A quote's date row is "Giltig till": the step reuses the due kind.
        focusSettingsField(isQuoteDoc ? 'valid_until' : 'due_date')
        break
      case 'rows_empty':
        entryInputRef.current?.focus()
        break
      case 'row_incomplete':
        // The unit cell is a Radix Select (not focusable via RHF): bring the
        // row into view instead.
        if (step.field === 'unit') scrollRowIntoView(step.index)
        else setFocus(`items.${step.index}.${step.field}`)
        break
      case 'payment_link':
        focusSettingsField('payment_link_url')
        break
      case 'personnummer':
        setPaymentPanelOpen(false)
        window.setTimeout(() => setFocus('deduction_personnummer'), 0)
        break
      case 'housing':
        setPaymentPanelOpen(false)
        window.setTimeout(() => setFocus('deduction_housing_designation'), 0)
        break
      case 'external_number':
        setFocus('external_invoice_number')
        break
      case 'ready':
        break
    }
  }

  function onInvalidSubmit(errs: FieldErrors<FormData>) {
    if (nextStep.kind !== 'ready') {
      focusStep(nextStep)
      return
    }
    // Field-adjacent problems the coarse next-step model does not cover
    // (accrual period, posting-account format): route by error order.
    const itemErrs = errs.items
    if (Array.isArray(itemErrs)) {
      for (let i = 0; i < itemErrs.length; i++) {
        const rowErr = itemErrs[i]
        if (!rowErr) continue
        for (const field of ['description', 'quantity', 'unit', 'unit_price'] as const) {
          if (rowErr[field]) {
            setFocus(`items.${i}.${field}`)
            return
          }
        }
        // A deduction row's arbetstyp and timmar live in the Skattereduktion
        // section, not on the row.
        if (rowErr.labor_hours) {
          setFocus(`items.${i}.labor_hours`)
          return
        }
        if (rowErr.work_type || rowErr.deduction_type) {
          document
            .getElementById(`invoice-editor-deduction-${i}`)
            ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
          return
        }
        scrollRowIntoView(i)
        return
      }
    }
    if (errs.payment_link_url) {
      focusSettingsField('payment_link_url')
      return
    }
    if (errs.customer_id) customerTriggerRef.current?.focus()
    else if (errs.invoice_date) focusSettingsField('invoice_date')
    else if (errs.valid_until) focusSettingsField('valid_until')
    else if (errs.due_date) focusSettingsField('due_date')
  }

  // "Spara som utkast": save an unnumbered draft (save_as_draft) without the
  // review dialog. The invoice gets no F-number and fires no invoice.created
  // until the user opens it and clicks "Granska & skapa" (finalize). Same
  // ROT/RUT privacy sanitization as handleConfirm.
  async function saveDraftData(data: FormData) {
    setIsSavingDraft(true)

    const payload = buildInvoiceWritePayload(withQuoteValidity(data), {
      saveAsDraft: true,
      oreRounding,
      defaultDims,
    })

    try {
      const response = await fetch('/api/invoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const result = await response.json()
      if (!response.ok) {
        throw new Error(getErrorMessage(result, { context: 'invoice', statusCode: response.status }))
      }
      toast({
        title: t('toast_draft_saved_title'),
        description: t('toast_draft_saved_description'),
      })
      // replace (here and in every post-save navigation): the editor page must
      // drop out of history, or the detail page's back arrow reopens a fresh
      // editor instead of returning to the list (issue #1053).
      router.replace(`/invoices/${result.data.id}`)
    } catch (error) {
      toast({
        title: t('save_draft_failed_title'),
        description: getErrorMessage(error, { context: 'invoice' }),
        variant: 'destructive',
      })
    } finally {
      setIsSavingDraft(false)
    }
  }

  // Edit mode: PATCH the existing draft (header + items). Same ROT/RUT privacy
  // sanitization as create: personal-data fields only ride along when a
  // deduction is actually claimed. No review dialog, no number allocation, no
  // send/logo prompt; on success go back to the invoice detail page.
  async function saveEdit(data: FormData) {
    if (!initial) return
    setIsSubmitting(true)

    const payload = buildInvoiceWritePayload(withQuoteValidity(data), {
      oreRounding,
      defaultDims,
    })

    try {
      const response = await fetch(`/api/invoices/${initial.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const result = await response.json()
      if (!response.ok) {
        throw new Error(getErrorMessage(result, { context: 'invoice', statusCode: response.status }))
      }
      toast({
        title: t('toast_draft_updated_title'),
        description: t('toast_draft_updated_description'),
      })
      router.replace(`/invoices/${initial.id}`)
    } catch (error) {
      toast({
        title: t('update_failed_title'),
        description: getErrorMessage(error, { context: 'invoice' }),
        variant: 'destructive',
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  // The document's own label (Faktura, Offert, ...): the edit title, the
  // first preview tab and the document-type switch.
  const docTypeLabel =
    watchDocumentType === 'proforma'
      ? t('doctype_proforma')
      : watchDocumentType === 'delivery_note'
        ? t('doctype_delivery_note')
        : watchDocumentType === 'quote'
          ? t('doctype_quote')
          : t('doctype_invoice')
  // The top bar's title doubles as the document-type switch, so it names the
  // type: "Ny offert" while creating, "Offert" when editing a saved draft
  // (the meta line says it is a draft).
  const titleText = isSelfBilled
    ? ts('title')
    : isEditMode
      ? docTypeLabel
      : watchDocumentType === 'proforma'
        ? t('title_proforma')
        : watchDocumentType === 'delivery_note'
          ? t('title_delivery_note')
          : watchDocumentType === 'quote'
            ? t('title_quote')
            : t('title_invoice')

  // Derived snabbflöde state: entry-row suggestions, the Förval chip line and
  // the single next-step line (components/invoices/invoice-editor-flow.ts).
  const entryMatches = filterArticleSuggestions(articles, entryQuery)
  const productRowCount = (watchItems ?? []).filter((i) => i?.line_type !== 'text').length
  const paymentLinkMode: 'auto' | 'manual' | null =
    watchDocumentType === 'invoice' && !isSelfBilled
      ? watchPaymentLinkUrl?.trim()
        ? 'manual'
        : stripeConnected && paymentLinksEnabled && (watchPaymentLinkAuto ?? true)
          ? 'auto'
          : null
      : null

  const nextStep = deriveNextStep({
    isSelfBilled,
    customerSelected: Boolean(watchCustomerId),
    invoiceDate: watchInvoiceDate || '',
    dueDate: (isQuoteDoc ? watchValidUntil : watchDueDate) || '',
    receivedDate: watchReceivedDate || '',
    externalInvoiceNumber: watchExternalNumber || '',
    items: watchItems ?? [],
    paymentLinkInvalid: Boolean(errors.payment_link_url),
    requiresPersonnummer:
      hasAnyDeduction && !(initial?.deduction_personnummer_last4 || customerHasPersonalNumber),
    personnummer: watchPersonnummer || '',
    // Gated on the claimed amount to match the claim card's mount condition
    // (hasAnyDeduction): a ROT-flagged line with a zero amount renders no
    // card, so the housing field the next-step link would focus does not
    // exist yet.
    requiresHousing: deriveRequiresHousing({
      hasRotLine: hasAnyRotLine,
      hasGronTeknikLine: hasAnyGronTeknikLine,
      deductionTotal,
    }),
    housingDesignation: watchHousingDesignation || '',
  })

  const nextStepLabels: Record<Exclude<NextStep['kind'], 'ready' | 'row_incomplete'>, string> = {
    customer: t('next_step_customer'),
    invoice_date: t('next_step_invoice_date'),
    due_date: isQuoteDoc ? t('next_step_valid_until') : t('next_step_due_date'),
    rows_empty: t('next_step_add_row'),
    payment_link: t('next_step_payment_link'),
    personnummer: t('next_step_personnummer'),
    housing: t('next_step_housing'),
    external_number: t('next_step_external_number'),
    received_date: t('next_step_received_date'),
  }
  const itemsRootError = errors.items as unknown as
    | { root?: { message?: string }; message?: string }
    | undefined
  const itemsRootMsg =
    itemsRootError?.root?.message ??
    (typeof itemsRootError?.message === 'string' ? itemsRootError.message : undefined)

  const inFlight = isSubmitting || isSavingDraft || isFormSubmitting

  // ===== One screen: channel, primary, live preview, status line =========
  // Pure rules in lib/invoices/editor/*, pinned by unit tests.
  const booksOnIssue = resolveBooksOnIssue(watchDocumentType, {
    accountingMethod,
    deferInvoiceBooking: companySettings?.defer_invoice_booking === true,
  })
  const channelContext: ChannelContext = {
    documentType: watchDocumentType,
    canEmail: hasEmailSend,
    isSandbox,
    customerSelected: Boolean(selectedCustomer),
    customerEmail: selectedCustomer?.email ?? null,
    // No company-access or customer-participant signal exists before the
    // invoice does; e-fakturor are sent from the detail page.
    peppolReady: false,
  }
  const channelOptions = resolveChannelOptions(channelContext)
  const channel = resolveEffectiveChannel(channelChoice, channelContext)
  const emailBlock = channelOptions.find((option) => option.channel === 'email')?.reason ?? null
  const editorMode = isEditMode ? 'edit' : 'create'
  const primaryContext = { mode: editorMode, isSelfBilled, documentType: watchDocumentType, channel, booksOnIssue } as const
  const primaryAction = resolvePrimaryAction(primaryContext)
  const editorMenu = resolveEditorMenu({ ...primaryContext, channelOptions })

  // This send's extra copies (Mejl tab, owner/admin), validated like the
  // send dialog does before the server sees them.
  const extraCc = parseInvoiceRecipientText(extraCcText)
  const invalidExtraCc = extraCc.find((address) => !EMAIL_PATTERN.test(address)) ?? null
  const extraCcError = invalidExtraCc ? tShell('email_copy_invalid', { address: invalidExtraCc }) : null

  // The live previews render what the write path would save: the same form
  // values through the same body builder (lib/invoices/editor/preview-request).
  const formValues = watch()
  const printedNumber = (isEditMode ? initial?.invoice_number : null) ?? numberPreview
  const previewRequest = isSelfBilled
    ? null
    : buildEditorPreviewRequest(formValues, { oreRounding, defaultDims, invoiceNumber: printedNumber ?? null })
  const previewBody = previewRequest ? JSON.stringify(previewRequest) : null
  const emailRequestBody = previewRequest
    ? JSON.stringify({
        ...previewRequest,
        email_subject: emailOverride?.subject ?? null,
        email_body: emailOverride?.body ?? null,
      })
    : null
  const pdf = useInvoicePdfPreview(previewBody, previewRefreshKey)
  const preliminaryNumber =
    !isSelfBilled && watchDocumentType !== 'delivery_note' && !(isEditMode && initial?.invoice_number)
      ? numberPreview
      : null

  // ===== Form sections (lib/invoices/editor/details, rows, payment-summary) =
  const todayIso = format(new Date(), 'yyyy-MM-dd')
  // The document's language follows the customer card (there is no
  // per-invoice language): English drops the OCR row and relabels the PDF.
  const documentLanguage: 'sv' | 'en' = selectedCustomer?.language === 'en' ? 'en' : 'sv'
  // The invoice date against the lock date and the fiscal periods, only where
  // sending books on it (a faktura under faktureringsmetoden).
  const dateLock =
    !isSelfBilled && booksOnIssue
      ? invoiceDateLock({
          date: watchInvoiceDate,
          lockedThrough: companySettings?.bookkeeping_locked_through,
          periods: fiscalPeriods,
        })
      : null
  const detailsReasons = resolveDetailsExpansion({
    documentType: watchDocumentType,
    isSelfBilled,
    currency: watchCurrency,
    language: documentLanguage,
    customerType: selectedCustomer?.customer_type,
    invoiceDate: watchInvoiceDate || '',
    deliveryDate: watchDeliveryDate || '',
    validUntil: watchValidUntil || '',
    dateLock,
  })
  const detailsExpanded = detailsOpen || detailsReasons.length > 0
  const detailsChips = resolveDetailsChips({
    documentType: watchDocumentType,
    isSelfBilled,
    invoiceDate: watchInvoiceDate || '',
    dueDate: watchDueDate || '',
    validUntil: watchValidUntil || '',
    currency: watchCurrency,
    language: documentLanguage,
    deliveryDate: watchDeliveryDate || '',
    dimensionsEnabled: dimensionsEnabled && isInvoiceDoc,
    dims: hasDimensionValues(defaultDims) ? compactDimensions(defaultDims) : null,
  })
  const dueDays = termDays(watchInvoiceDate || '', watchDueDate || '')
  const validityDays = termDays(watchInvoiceDate || '', watchValidUntil || '')
  const detailsReasonLabel = (reason: DetailsReason) =>
    reason === 'currency' ? watchCurrency : tForm(`details_reason_${reason}`)
  const detailsAside =
    detailsReasons.length > 0 ? (
      tForm('details_aside_reasons', { reasons: detailsReasons.map(detailsReasonLabel).join(', ') })
    ) : (
      <button type="button" className={QUIET_LINK_CLASS} onClick={() => setDetailsOpen(false)}>
        {tForm('details_fold')}
      </button>
    )

  // Kund: one muted line, an exception chip for anything but a Swedish
  // business, and the VIES state of an EU business.
  const customerTypeLabel =
    selectedCustomer?.customer_type === 'individual'
      ? tForm('customer_private')
      : selectedCustomer?.customer_type === 'eu_business'
        ? tForm('customer_eu')
        : selectedCustomer?.customer_type === 'non_eu_business'
          ? tForm('customer_non_eu')
          : null
  const customerLine = selectedCustomer
    ? [
        selectedCustomer.customer_type === 'individual' ? '' : selectedCustomer.org_number ?? '',
        [selectedCustomer.address_line1, [selectedCustomer.postal_code, selectedCustomer.city].filter(Boolean).join(' ')]
          .filter(Boolean)
          .join(', '),
        selectedCustomer.email ?? '',
      ]
        .filter(Boolean)
        .join(' · ')
    : ''
  const viesLine =
    selectedCustomer?.customer_type === 'eu_business' &&
    selectedCustomer.vat_number_validated &&
    selectedCustomer.vat_number
      ? selectedCustomer.vat_number_validated_at
        ? tForm('vies_valid_on', {
            number: selectedCustomer.vat_number,
            date: formatDate(selectedCustomer.vat_number_validated_at),
          })
        : tForm('vies_valid', { number: selectedCustomer.vat_number })
      : null
  const watchInvoiceMarking = watch('invoice_marking')

  // Skattereduktion: the rows that claim one, and what the section says.
  const deductionRowIndexes = (watchItems ?? [])
    .map((item, index) => (item?.line_type !== 'text' && item?.deduction_type ? index : -1))
    .filter((index) => index >= 0)
  const hasAnyRotRutLine =
    isInvoiceDoc && (watchItems ?? []).some((i) => i?.deduction_type === 'rot' || i?.deduction_type === 'rut')
  const deductionKinds = new Set(deductionRowIndexes.map((index) => watchItems[index]?.deduction_type))
  const deductionAside =
    deductionKinds.size === 1
      ? deductionKinds.has('rot')
        ? tForm('deduction_aside_rot')
        : deductionKinds.has('rut')
          ? tForm('deduction_aside_rut')
          : tForm('deduction_aside_gron')
      : deductionKinds.size > 1
        ? tForm('deduction_aside_mixed')
        : null
  // The kundkort's personnummer only reaches the browser masked; show the
  // mask as what an empty field falls back to.
  const customerMaskedPersonalNumber =
    selectedCustomer?.personal_number && isMaskedPersonalNumber(selectedCustomer.personal_number)
      && selectedCustomer.personal_number !== UNDECRYPTABLE_PERSONAL_NUMBER_MASK
      ? selectedCustomer.personal_number
      : null
  // Öresavrundning applies to this total if it is on: the Summering row and
  // its switch show only then.
  const { rounding: potentialRounding } = getAmountToPay(
    { total, currency: watchCurrency, ore_rounding: true, deduction_total: deductionTotal },
    null,
  )

  // Betalning: the summary line from the same functions the PDF uses.
  const watchQrMode = watch('qr_mode')
  const chosenPayee = watchPayeeAccount
    ? payeeState?.accounts.find((account) => account.id === watchPayeeAccount) ?? null
    : null
  const chosenPayeeDetails = chosenPayee ? cashAccountPayee(chosenPayee) : null
  const printablePaymentLink = (() => {
    const url = watchPaymentLinkUrl?.trim()
    if (!url) return null
    try {
      return new URL(url).protocol === 'https:' ? url : null
    } catch {
      return null
    }
  })()
  const paymentSummaryInput: EditorPaymentSummaryInput | null =
    companySettings && !isSelfBilled && watchDocumentType === 'invoice'
      ? {
          settings: companySettings,
          currency: watchCurrency as Currency,
          payee: chosenPayeeDetails,
          invoice: {
            invoice_number: printedNumber ?? null,
            document_type: watchDocumentType,
            total,
            deduction_total: deductionTotal,
            ore_rounding: oreRounding,
            qr_mode: watchQrMode ?? null,
            payment_link_url: printablePaymentLink,
            due_date: watchDueDate || null,
            invoice_date: watchInvoiceDate || null,
          },
          customer: selectedCustomer,
          lang: documentLanguage,
          autoPaymentLink: paymentLinkMode === 'auto',
        }
      : null
  const paymentSummary = paymentSummaryInput ? buildEditorPaymentSummary(paymentSummaryInput) : null
  const paymentOverridden = Boolean(watchQrMode) || Boolean(watchPayeeAccount)
  const qrReasonFor = (mode: InvoiceQrMode): string | null => {
    if (!paymentSummaryInput) return null
    const summary = buildEditorPaymentSummary({
      ...paymentSummaryInput,
      invoice: { ...paymentSummaryInput.invoice, qr_mode: mode },
    })
    if (summary.qr.kind) return null
    const reason = paymentReason(summary, {
      lang: documentLanguage,
      showOcr: companySettings?.invoice_show_ocr ?? true,
    })
    return reason ? tPay(reason.key) : null
  }
  const paymentCompany = companySettings
    ? companyWithInvoicePaymentAccount(companySettings, watchCurrency as Currency, chosenPayeeDetails)
    : null
  const printedPayee = {
    bankgiro: paymentCompany?.bankgiro?.trim() || null,
    plusgiro: paymentCompany?.plusgiro?.trim() || null,
    swish: paymentCompany?.swish?.trim() || null,
    bankAccount:
      paymentSummary?.methods.find((row) => row.key === 'bank_account')?.value ?? null,
  }
  const paymentPanelSettings = paymentSummaryInput ? companySettings : null
  // Betalas till: only when there is a real choice for the currency.
  const payeeField =
    !isSelfBilled &&
    watchDocumentType === 'invoice' &&
    payeeState &&
    (payeeOptions.length > 1 ||
      (payeeOptions.length === 1 && !defaultPayee) ||
      (watchPayeeAccount && payeeOptions.length > 0)) ? (
      <Controller
        name="payment_cash_account_id"
        control={control}
        render={({ field }) => (
          <Select
            value={field.value || PAYEE_DEFAULT}
            onValueChange={(value) => field.onChange(value === PAYEE_DEFAULT ? '' : value)}
          >
            <SelectTrigger aria-label={t('payee_account_label')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={PAYEE_DEFAULT}>
                {defaultPayee
                  ? t('payee_account_default', { account: payeeAccountLabel(defaultPayee) })
                  : t('payee_account_default_none')}
              </SelectItem>
              {payeeOptions.map((account) => (
                <SelectItem key={account.id} value={account.id}>
                  {payeeAccountLabel(account)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      />
    ) : null
  // Online payment link: manual paste or the Stripe auto toggle. Only real
  // invoices; hidden unless the company opted in, except when the draft
  // already carries a link.
  const paymentLinkField =
    !isSelfBilled && watchDocumentType === 'invoice' && (paymentLinksEnabled || hasExistingPaymentLink) ? (
      <div className="space-y-2 text-[13px]">
        <Label htmlFor="payment_link_url" className={FIELD_LABEL_CLASS}>
          {t('payment_link_label')}
        </Label>
        <Input
          id="payment_link_url"
          type="url"
          inputMode="url"
          placeholder={t('payment_link_placeholder')}
          className="text-[13px]"
          {...register('payment_link_url')}
        />
        {errors.payment_link_url ? (
          <p className="text-sm text-destructive">{errors.payment_link_url.message}</p>
        ) : (
          <p className={FIELD_HINT_CLASS}>
            {stripeConnected ? t('payment_link_hint_auto') : t('payment_link_hint')}
          </p>
        )}
        {stripeConnected && !watchPaymentLinkUrl?.trim() && (
          <div className="flex items-center gap-2">
            <Switch
              id="payment_link_auto"
              checked={watchPaymentLinkAuto ?? true}
              onCheckedChange={(v) => setValue('payment_link_auto', v, { shouldDirty: true })}
            />
            <Label htmlFor="payment_link_auto" className="text-[13px] font-normal text-muted-foreground">
              {t('payment_link_auto_label')}
            </Label>
          </div>
        )}
      </div>
    ) : null

  const statusLine = resolveEditorStatusLine({
    nextStep,
    missing: pdf.missing,
    documentType: watchDocumentType,
    pageCount: isSelfBilled ? null : pdf.pageCount,
    previewFailed: Boolean(pdf.error),
    notes: formValues.notes ?? '',
    productRowCount,
    hasDeduction: hasAnyDeduction,
    dateLock,
  })
  const [pane, setPane] = useState<EditorPane>('form')
  const describeStep = (step: NextStep) => ({
    prefix: t('next_step_prefix'),
    label:
      step.kind === 'ready'
        ? ''
        : step.kind === 'row_incomplete'
          ? t('next_step_row_incomplete', { index: step.index + 1 })
          : nextStepLabels[step.kind],
  })
  // A jump link in the preview pane at narrow widths: show the form first,
  // then focus the field once it is laid out.
  const jumpToStep = (step: NextStep) => {
    setPane('form')
    window.setTimeout(() => focusStep(step), 0)
  }
  const renderStatusLine = (className?: string) => (
    <EditorStatusLine
      status={statusLine}
      describeStep={describeStep}
      onStep={jumpToStep}
      canAddPayee={isCompanyAdmin && canWrite}
      onAddPayee={openPayeeFix}
      onFixDate={() => focusSettingsField('invoice_date')}
      className={className}
    />
  )

  // Cmd/Ctrl+Enter runs the primary (it opens the confirm; Enter there
  // sends). Through refs so the listener is bound once.
  const requestIntentRef = useRef(requestIntent)
  const primaryIntentRef = useRef(primaryAction.intent)
  useEffect(() => {
    requestIntentRef.current = requestIntent
    primaryIntentRef.current = primaryAction.intent
  })
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey) || event.defaultPrevented) return
      // A dialog (confirm, new customer, bank details) owns the keyboard.
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return
      event.preventDefault()
      requestIntentRef.current(primaryIntentRef.current)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  // ===== Confirm dialog ====================================================
  const confirmData = pendingData
  const confirmDocType = confirmData?.document_type ?? watchDocumentType
  const confirmChannel = confirmIntent?.kind === 'send' ? confirmIntent.channel : null
  const confirmNumber =
    confirmDocType === 'delivery_note' && !isEditMode
      ? null
      : (isEditMode ? initial?.invoice_number : null) ?? numberPreview
  const confirmDoc = tShell(`doc_${confirmDocType}`)
  const confirmCustomer = selectedCustomer?.name ?? ''
  const confirmTitleKey =
    confirmIntent?.kind === 'create'
      ? 'confirm_title_create'
      : confirmChannel === 'email'
        ? 'confirm_title_email'
        : 'confirm_title_manual'
  const confirmTitle = confirmNumber
    ? tShell(confirmTitleKey, { doc: confirmDoc, number: confirmNumber, customer: confirmCustomer })
    : tShell(`${confirmTitleKey}_no_number`, { doc: confirmDoc, customer: confirmCustomer })
  const confirmCurrency = (confirmData?.currency ?? watchCurrency) as Currency
  const confirmRows: Array<{ label: string; value: string }> = []
  if (confirmChannel === 'email') {
    confirmRows.push({
      label: tShell('confirm_row_to'),
      value: [tShell('confirm_to_with_pdf', { email: selectedCustomer?.email ?? '' }), ...(isCompanyAdmin ? extraCc : [])].join(', '),
    })
  } else if (confirmChannel) {
    confirmRows.push({ label: tShell('confirm_row_channel'), value: tShell('confirm_channel_manual') })
  }
  confirmRows.push({
    label: tShell('confirm_row_number'),
    value: confirmNumber ? tShell('confirm_number_locks', { number: confirmNumber }) : tShell('confirm_number_next'),
  })
  if (confirmDocType === 'quote') {
    confirmRows.push({
      label: tShell('confirm_row_total'),
      value: tShell('confirm_amount_valid', {
        amount: formatCurrency(displayedToPay, confirmCurrency),
        date: withQuoteValidity({ document_type: 'quote', due_date: confirmData?.due_date ?? '', valid_until: confirmData?.valid_until }).due_date,
      }),
    })
  } else if (confirmDocType !== 'delivery_note') {
    confirmRows.push({
      label: hasAnyDeduction || confirmDocType === 'invoice' ? t('to_pay_label') : t('total_label'),
      value: tShell('confirm_amount_due', {
        amount: formatCurrency(displayedToPay, confirmCurrency),
        date: confirmData?.due_date ?? '',
      }),
    })
  }
  const entityType: EntityType =
    (companySettings?.entity_type as EntityType | null | undefined) ?? company?.entity_type ?? 'enskild_firma'
  const accountNames = new Map(activeAccounts.map((account) => [account.account_number, account.account_name]))
  let confirmVoucher: ConfirmVoucher | null = null
  if (confirmIntent?.kind === 'create') {
    confirmVoucher = { kind: 'note', text: tShell('confirm_create_note') }
  } else if (confirmChannel && confirmDocType === 'invoice' && confirmData) {
    if (!booksOnIssue) {
      confirmVoucher = {
        kind: 'note',
        text: accountingMethod === 'cash' ? tShell('confirm_voucher_cash') : tShell('confirm_voucher_deferred'),
      }
    } else if (confirmCurrency !== 'SEK') {
      confirmVoucher = { kind: 'note', text: tShell('confirm_voucher_foreign') }
    } else {
      const lines = proposeDraftSendLines({
        invoiceNumber: confirmNumber ?? null,
        currency: confirmCurrency,
        vatTreatment: vatRules?.treatment ?? 'standard_25',
        vatRegistered,
        defaultVatRate: vatRules?.rate || 25,
        items: confirmData.items,
        defaultDimensions: defaultDims,
        entityType,
      })
      if (lines.length > 0) {
        confirmVoucher = {
          kind: 'lines',
          date: confirmData.invoice_date,
          lines: lines.map((line) => ({
            account: line.account_number,
            name: accountNames.get(line.account_number) ?? line.line_description,
            debit: parseFloat(line.debit_amount) || 0,
            credit: parseFloat(line.credit_amount) || 0,
          })),
        }
      }
    }
  }
  const confirmLabel =
    confirmIntent?.kind === 'create'
      ? tShell('action_create_without_sending')
      : tShell(resolveSendLabel({ documentType: confirmDocType, channel: confirmChannel ?? channel, booksOnIssue }))
  const confirmDisabled =
    !canWrite ||
    (needsSwedishVatAcknowledgement && !swedishVatAcknowledged) ||
    (confirmChannel === 'email' && isCompanyAdmin && extraCcError !== null)

  // ===== Top bar ===========================================================
  // Locked: quotes and delivery notes are numbered from their own series at
  // insert, so a saved one cannot change type (the API refuses it too).
  const docTypeLocked = isEditMode && (initial?.document_type === 'quote' || initial?.document_type === 'delivery_note')
  const documentTypeOptions: Array<{ value: InvoiceDocumentType; label: string }> | null =
    isSelfBilled || docTypeLocked
      ? null
      : [
          { value: 'invoice', label: t('doctype_invoice') },
          // Kinds switched off in Inställningar > Försäljning are hidden
          // unless this document already is one.
          ...(watchDocumentType === 'proforma' || isInvoiceTypeEnabled(companySettings, 'proforma_enabled')
            ? [{ value: 'proforma' as const, label: t('doctype_proforma') }]
            : []),
          ...(watchDocumentType === 'quote' || isInvoiceTypeEnabled(companySettings, 'quotes_enabled')
            ? [{ value: 'quote' as const, label: t('doctype_quote') }]
            : []),
          { value: 'delivery_note', label: t('doctype_delivery_note') },
        ]
  const updatedAt = initial?.updated_at ? new Date(initial.updated_at) : null
  const metaText = isSelfBilled
    ? ''
    : isCopyMode && copyInitial
      ? tShell('meta_copy', { number: copyInitial.source_invoice_number })
      : isEditMode && updatedAt && !Number.isNaN(updatedAt.getTime())
        ? tShell('meta_saved', {
            time:
              format(updatedAt, 'yyyy-MM-dd') === format(new Date(), 'yyyy-MM-dd')
                ? format(updatedAt, 'HH:mm')
                : format(updatedAt, 'yyyy-MM-dd HH:mm'),
          })
        : tShell('meta_draft')
  const menuEntries: { channels: TopBarMenuEntry[]; actions: TopBarMenuEntry[] } | null = editorMenu
    ? {
        channels: editorMenu.channels.map((entry) => ({
          key: entry.channel,
          label: tShell(entry.label),
          selected: entry.selected,
          disabled: !entry.available || !canWrite,
          reason: entry.reason ? tShell(EMAIL_BLOCK_KEYS[entry.reason]) : null,
          onSelect: () => requestIntent(entry.intent),
        })),
        actions: editorMenu.actions.map((entry) => ({
          key: entry.intent.kind,
          label: tShell(entry.label),
          disabled: !canWrite,
          onSelect: () => requestIntent(entry.intent),
        })),
      }
    : null
  const breadcrumb =
    watchDocumentType === 'quote' && !isSelfBilled
      ? { label: tNav('quotes'), href: '/quotes' }
      : { label: tNav('invoices'), href: '/invoices' }

  return (
    <>
    <InvoiceEditorShell
      pane={pane}
      onPaneChange={setPane}
      renderTopBar={(paneSwitch) => (
        <EditorTopBar
          breadcrumb={breadcrumb}
          title={titleText}
          documentTypes={documentTypeOptions}
          documentType={watchDocumentType}
          onDocumentTypeChange={(value) =>
            setValue('document_type', value, { shouldDirty: true, shouldValidate: false })
          }
          help={
            <>
              <p>{isSelfBilled ? tShell('help_self_billed') : tShell('help')}</p>
              {isCopyMode && copyInitial && (
                <p className="mt-2">{t('copy_notice', { number: copyInitial.source_invoice_number })}</p>
              )}
            </>
          }
          meta={metaText}
          paneSwitch={paneSwitch}
          primary={{
            label: tShell(primaryAction.label),
            onClick: () => requestIntent(primaryAction.intent),
            disabled: inFlight || !canWrite,
            loading: inFlight && confirmIntent === null,
            title: !canWrite ? t('viewer_disabled_tooltip') : undefined,
            locked: !canWrite,
          }}
          menu={menuEntries}
        />
      )}
      preview={
        isSelfBilled ? null : (
          <EditorPreviewPane
            documentLabel={docTypeLabel}
            pdf={pdf}
            preliminaryNumber={preliminaryNumber}
            statusLine={renderStatusLine()}
            renderEmail={() => (
              <EditorEmailPreview
                requestBody={emailRequestBody}
                unavailableReason={
                  channel === 'email'
                    ? null
                    : emailBlock
                      ? tShell(EMAIL_BLOCK_KEYS[emailBlock])
                      : tShell('email_unavailable_manual')
                }
                onUseEmail={channel !== 'email' && !emailBlock ? () => setChannelChoice('email') : null}
                override={emailOverride}
                onOverrideChange={setEmailOverride}
                canAddCopies={isCompanyAdmin}
                extraCcText={extraCcText}
                onExtraCcTextChange={setExtraCcText}
                extraCcError={extraCcError}
              />
            )}
          />
        )
      }
      form={
      // No submit button inside: every action runs from the top bar
      // (requestIntent), and Enter in a field never sends.
      <form noValidate onSubmit={(event) => event.preventDefault()}>
        {paymentPanelOpen && paymentPanelSettings && (
          // "Betalning och utseende" takes the column's place; the form
          // stays mounted (hidden) so nothing typed is lost.
          <PaymentPanel
            scope={paymentPanelScope}
            onScopeChange={setPaymentPanelScope}
            canEditCompany={isCompanyAdmin && canWrite}
            settings={paymentPanelSettings}
            printed={printedPayee}
            onSettingsSaved={handleSettingsSaved}
            invoiceQrMode={watchQrMode ?? null}
            onInvoiceQrModeChange={(mode) => setValue('qr_mode', mode, { shouldDirty: true })}
            qrReasonFor={qrReasonFor}
            payeeField={payeeField}
            paymentLinkField={paymentLinkField}
            onClose={() => {
              setPaymentPanelOpen(false)
              // Back where "Ändra" was.
              window.setTimeout(() => {
                document.getElementById('invoice-editor-payment')?.scrollIntoView({ block: 'center' })
              }, 0)
            }}
          />
        )}
        <div hidden={paymentPanelOpen && paymentPanelSettings !== null} className="space-y-8">
          {/* ===== Kund ===== */}
          <EditorSection
            label={
              <>
                {isSelfBilled ? ts('customer_label') : t('customer_card_title')}
                <RequiredMark />
              </>
            }
            aside={
              !selectedCustomer && canWrite ? (
                <button
                  type="button"
                  className={QUIET_LINK_CLASS}
                  onClick={() => {
                    setCreateCustomerPrefill('')
                    setIsCreateCustomerOpen(true)
                  }}
                >
                  + {tForm('new_customer')}
                </button>
              ) : null
            }
          >
            {isSelfBilled && (
              <p className="-mt-1 mb-3 text-xs text-muted-foreground">{ts('issuer_card_description')}</p>
            )}
            <Controller
              name="customer_id"
              control={control}
              render={({ field }) => (
                <CustomerCombobox
                  value={field.value}
                  customers={customers}
                  keepId={keepCustomerId}
                  onChange={field.onChange}
                  inputRef={customerTriggerRef}
                  className="h-11 text-[15px]"
                  aria-required
                  loading={customersLoading}
                  loadingLabel={t('loading_customers')}
                  emptyLabel={t('no_customers_yet')}
                  onCreateCustomer={(prefill) => {
                    setCreateCustomerPrefill(prefill)
                    setIsCreateCustomerOpen(true)
                  }}
                />
              )}
            />
            {selectedCustomer && (
              <div
                className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] leading-5 text-muted-foreground"
                data-ph-mask=""
              >
                {customerTypeLabel && <Badge variant="secondary">{customerTypeLabel}</Badge>}
                <span>{customerLine}</span>
              </div>
            )}
            {/* Why the VAT treatment is what it is, muted: the page's single
                ochre line is the status line. The VIES check for an
                unvalidated EU customer sits inline; a validated one says so. */}
            {selectedCustomer && vatWarnings.length > 0 ? (
              <VatTreatmentNotice
                className="mt-2"
                tone="muted"
                customer={selectedCustomer}
                lineVatRates={effectiveLineVatRates}
                onValidated={handleCustomerVatValidated}
              />
            ) : viesLine ? (
              <p className="mt-2 text-[12.5px] leading-5 text-muted-foreground" data-ph-mask="">
                {viesLine}
              </p>
            ) : null}
            {errors.customer_id && (
              <p className="mt-2 text-sm text-destructive">{errors.customer_id.message}</p>
            )}

            {/* References are per-invoice data, not defaults: always visible
                next to the customer (crm#136, crm#187). Märkning is asked for
                when needed. Self-billed mode keeps not rendering them. */}
            {!isSelfBilled && (
              <>
                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  <div className="min-w-0 space-y-2">
                    <Label className={FIELD_LABEL_CLASS}>{t('your_reference_label')}</Label>
                    <Controller
                      name="your_reference"
                      control={control}
                      render={({ field }) => (
                        <TagInput
                          value={field.value ?? ''}
                          onChange={field.onChange}
                          placeholder={t('your_reference_placeholder')}
                          className="text-[13px]"
                        />
                      )}
                    />
                  </div>
                  <div className="min-w-0 space-y-2">
                    <Label className={FIELD_LABEL_CLASS}>{t('our_reference_label')}</Label>
                    <Controller
                      name="our_reference"
                      control={control}
                      render={({ field }) => (
                        <TagInput
                          value={field.value ?? ''}
                          onChange={field.onChange}
                          placeholder={t('our_reference_placeholder')}
                          className="text-[13px]"
                        />
                      )}
                    />
                  </div>
                </div>
                {/* Fakturamärkning: one buyer-required marking string
                    (kostnadsställe/projekt/PO), separate from Er referens.
                    Plain input, never comma-split. */}
                {markingOpen || watchInvoiceMarking ? (
                  <div className="mt-4 space-y-2">
                    <Label htmlFor="invoice_marking" className={FIELD_LABEL_CLASS}>
                      {t('invoice_marking_label')}
                    </Label>
                    <Input
                      id="invoice_marking"
                      maxLength={200}
                      placeholder={t('invoice_marking_placeholder')}
                      className="text-[13px]"
                      {...register('invoice_marking')}
                    />
                  </div>
                ) : (
                  <button
                    type="button"
                    className={cn(ADD_ROW_LINK_CLASS, 'mt-3')}
                    onClick={() => {
                      setMarkingOpen(true)
                      window.setTimeout(() => setFocus('invoice_marking'), 0)
                    }}
                  >
                    + {t('invoice_marking_label')}
                  </button>
                )}
              </>
            )}

            {isSelfBilled && (
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>{ts('external_number_label')}<RequiredMark /></Label>
                  <Input placeholder={ts('external_number_placeholder')} {...register('external_invoice_number')} />
                  {errors.external_invoice_number && (
                    <p className="text-sm text-destructive">{errors.external_invoice_number.message}</p>
                  )}
                </div>
                <div className="space-y-2">
                  <Label>{ts('agreement_ref_label')}</Label>
                  <Input placeholder={ts('agreement_ref_placeholder')} {...register('self_billing_agreement_ref')} />
                </div>
                {/* The counterparty's issue date and our received date are
                    mandatory transcription fields, not defaults: keep them
                    visible instead of folded into Detaljer, where the
                    silent today-default registered wrong dates on immutable
                    self-billed invoices (issue #1820). */}
                <div className="space-y-2">
                  <Label>{ts('invoice_date_label')}<RequiredMark /></Label>
                  <Input
                    type="date"
                    {...register('invoice_date')}
                    aria-required="true"
                    className="tabular-nums"
                  />
                  {errors.invoice_date && (
                    <p className="text-sm text-destructive">{errors.invoice_date.message}</p>
                  )}
                </div>
                <div className="space-y-2">
                  <Label>{ts('received_date_label')}<RequiredMark /></Label>
                  <Input
                    type="date"
                    {...register('received_date')}
                    aria-required="true"
                    className="tabular-nums"
                  />
                  <p className="text-xs text-muted-foreground">{ts('received_date_help')}</p>
                  {errors.received_date && (
                    <p className="text-sm text-destructive">{errors.received_date.message}</p>
                  )}
                </div>
              </div>
            )}
          </EditorSection>

          {/* ===== Detaljer: chips, or the fields when something is unusual ===== */}
          {detailsExpanded ? (
            <EditorSection id="invoice-editor-details" label={tForm('details_title')} aside={detailsAside}>
              <div className="grid gap-4 sm:grid-cols-2">
                {!isSelfBilled && (
                  <div className="space-y-2">
                    <Label htmlFor="invoice_date" className={FIELD_LABEL_CLASS}>
                      {isQuoteDoc ? tForm('quote_date_label') : t('invoice_date_label')}
                      <RequiredMark />
                    </Label>
                    <Input
                      id="invoice_date"
                      type="date"
                      {...register('invoice_date')}
                      aria-required="true"
                      className="tabular-nums"
                    />
                    {errors.invoice_date ? (
                      <p className="text-xs text-destructive">{errors.invoice_date.message}</p>
                    ) : dateLock ? (
                      <p className={FIELD_HINT_CLASS}>{tForm(`date_lock_${dateLock}`)}</p>
                    ) : null}
                  </div>
                )}
                {isQuoteDoc ? (
                  <div className="space-y-2">
                    <Label htmlFor="valid_until" className={FIELD_LABEL_CLASS}>
                      {t('valid_until_label')}
                      <RequiredMark />
                    </Label>
                    <Input
                      id="valid_until"
                      type="date"
                      {...register('valid_until')}
                      aria-required="true"
                      className="tabular-nums"
                    />
                    {errors.valid_until ? (
                      <p className="text-xs text-destructive">{errors.valid_until.message}</p>
                    ) : validityDays !== null && validityDays >= 0 ? (
                      <p className={FIELD_HINT_CLASS}>{tForm('term_days', { days: validityDays })}</p>
                    ) : null}
                  </div>
                ) : (
                  <div className="space-y-2">
                    <Label htmlFor="due_date" className={FIELD_LABEL_CLASS}>
                      {t('due_date_label')}
                      <RequiredMark />
                    </Label>
                    <Input
                      id="due_date"
                      type="date"
                      {...register('due_date')}
                      aria-required="true"
                      className="tabular-nums"
                    />
                    {errors.due_date ? (
                      <p className="text-xs text-destructive">{errors.due_date.message}</p>
                    ) : dueDays !== null && dueDays >= 0 ? (
                      <p className={FIELD_HINT_CLASS}>{tForm('term_days', { days: dueDays })}</p>
                    ) : null}
                  </div>
                )}
                <div className="space-y-2">
                  <Label className={FIELD_LABEL_CLASS}>{t('currency_label')}</Label>
                  <Controller
                    name="currency"
                    control={control}
                    render={({ field }) => (
                      <Select value={field.value} onValueChange={field.onChange}>
                        <SelectTrigger data-field="currency" className="tabular-nums" aria-label={t('currency_label')}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {currencies.map((currency) => (
                            <SelectItem key={currency} value={currency}>
                              {currency}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  />
                </div>
                {!isSelfBilled && (
                  <div className="space-y-2">
                    <Label htmlFor="invoice-language" className={FIELD_LABEL_CLASS}>
                      {tForm('language_label')}
                    </Label>
                    <Input
                      id="invoice-language"
                      value={documentLanguage === 'en' ? tForm('language_en') : tForm('language_sv')}
                      readOnly
                      disabled
                    />
                    <p className={FIELD_HINT_CLASS}>
                      {tForm('language_from_customer')}
                      {selectedCustomer && (
                        <>
                          {' '}
                          <Link
                            href={`/customers/${selectedCustomer.id}`}
                            className="underline underline-offset-2 hover:text-foreground"
                          >
                            {tForm('language_change')}
                          </Link>
                        </>
                      )}
                    </p>
                  </div>
                )}
                {watchDocumentType === 'invoice' && !isSelfBilled && (deliveryOpen || watchDeliveryDate) && (
                  <div className="space-y-2">
                    <Label htmlFor="delivery_date" className={FIELD_LABEL_CLASS}>
                      {t('delivery_date_label')}
                    </Label>
                    <Input id="delivery_date" type="date" {...register('delivery_date')} className="tabular-nums" />
                    <p className={FIELD_HINT_CLASS}>{tForm('delivery_hint')}</p>
                  </div>
                )}
              </div>
              {/* Invoice-level default dims (kostnadsställe/projekt). */}
              {dimensionsEnabled && isInvoiceDoc && (defaultDimsOpen || hasDimensionValues(defaultDims)) && (
                <div className="mt-4">
                  <LineDimensionFields dimensions={defaultDims} onChange={setDefaultDimension} />
                </div>
              )}
              {(() => {
                const adds: Array<{ key: string; label: string; onClick: () => void }> = []
                if (watchDocumentType === 'invoice' && !isSelfBilled && !deliveryOpen && !watchDeliveryDate) {
                  adds.push({ key: 'delivery', label: t('delivery_date_label'), onClick: () => focusSettingsField('delivery_date') })
                }
                if (dimensionsEnabled && isInvoiceDoc && !defaultDimsOpen && !hasDimensionValues(defaultDims)) {
                  adds.push({ key: 'dims', label: tForm('dimensions_label'), onClick: () => setDefaultDimsOpen(true) })
                }
                return adds.length > 0 ? (
                  <div className="mt-3 flex flex-wrap gap-4">
                    {adds.map((add) => (
                      <button key={add.key} type="button" className={ADD_ROW_LINK_CLASS} onClick={add.onClick}>
                        + {add.label}
                      </button>
                    ))}
                  </div>
                ) : null
              })()}
              {watchCurrency !== 'SEK' && (
                <p className={cn(FIELD_HINT_CLASS, 'mt-3')}>
                  {pdf.exchangeRate
                    ? tForm(pdf.exchangeRateDate ? 'rate_line' : 'rate_line_no_date', {
                        rate: pdf.exchangeRate.toLocaleString(locale === 'en' ? 'en-GB' : 'sv-SE', {
                          maximumFractionDigits: 4,
                        }),
                        currency: watchCurrency,
                        date: pdf.exchangeRateDate ?? '',
                      })
                    : tForm('rate_pending')}
                </p>
              )}
            </EditorSection>
          ) : (
            <DetailsChips
              chips={detailsChips}
              isQuote={isQuoteDoc}
              today={todayIso}
              onSelect={handleDetailsChip}
            />
          )}

          {/* ===== Rader ===== */}
          <EditorSection
            label={tForm('rows_title')}
            aside={productRowCount > 0 ? t('rows_count', { count: productRowCount }) : null}
          >
            <div ref={entryRootRef} className="relative">
              <div className="overflow-x-auto">
                <UnitDatalist />
                <div>
                  {/* Header row: offset by the drag-grip gutter (w-8). */}
                  <div className="pl-8">
                    <div className={cn(rowGridClass, 'border-b border-border pb-2 text-[11px] uppercase tracking-[0.08em] text-muted-foreground')}>
                      <div className="px-2">{t('description_label')}</div>
                      <div className="px-2 text-right">{t('quantity_label')}</div>
                      <div className="px-2 text-right">{t('unit_price_label')}</div>
                      {showVatColumn && <div className="px-2">{t('vat_label')}</div>}
                      {showDeductionColumn && <div className="px-2">{tForm('deduction_column')}</div>}
                      <div className="px-2 text-right">{t('amount_label')}</div>
                      <div />
                    </div>
                  </div>

                  <Reorder.Group as="div" axis="y" values={fields} onReorder={handleItemsReorder}>
                    {fields.map((field, index) => {
                      const item = watchItems[index]
                      const isTextRow = item?.line_type === 'text'
                      const rowDescription = item?.description?.trim()
                      const removeLabel = t('remove_row_aria_named', {
                        description: rowDescription || t('row_label', { index: index + 1 }),
                      })
                      if (isTextRow) {
                        return (
                          <SortableRow
                            key={field.id}
                            value={field}
                            handleLabel={t('drag_handle_aria')}
                            disabled={fields.length === 1}
                          >
                            <div
                              id={`invoice-editor-row-${index}`}
                              className={cn('group border-b border-border', settleIndex === index && 'row-settle')}
                            >
                              <div className="flex items-center gap-1 py-1">
                                <AutoGrowTextarea
                                  {...register(`items.${index}.description`)}
                                  placeholder={t('text_row_placeholder')}
                                  aria-label={t('text_row_label')}
                                  className={cn(CELL_INPUT_CLASS, 'w-full italic text-muted-foreground')}
                                />
                                <span className={cn('flex items-center', HOVER_REVEAL_CLASS)}>
                                  <button
                                    type="button"
                                    className={cn(ROW_ICON_BUTTON_CLASS, 'hover:text-destructive')}
                                    onClick={() => remove(index)}
                                    aria-label={removeLabel}
                                  >
                                    <X className="h-4 w-4" />
                                  </button>
                                </span>
                              </div>
                            </div>
                          </SortableRow>
                        )
                      }

                      const lineTotal = computeLineNet(
                        item?.quantity || 0,
                        item?.unit_price || 0,
                        item?.discount_percent,
                      )
                      const rowErrors = errors.items?.[index]
                      const rowErrorMsg =
                        rowErrors?.description?.message ??
                        rowErrors?.quantity?.message ??
                        rowErrors?.unit?.message ??
                        (rowErrors?.unit_price ? t('validation_price_invalid') : undefined)
                      const articleStripOpen = articlePickerRows.has(index)
                      // Each option's strip opens from the row menu or its
                      // badge, and by itself only when it carries an error.
                      const accountStripOpen =
                        isInvoiceDoc && (accountOverrideRows.has(index) || Boolean(rowErrors?.revenue_account))
                      // Not offered for a received självfaktura: the self-billed
                      // endpoint's reduced item shape carries no discount, so a
                      // previewed rebate would silently book gross.
                      const discountStripOpen =
                        !isSelfBilled && (discountRows.has(index) || Boolean(rowErrors?.discount_percent))
                      const dimensionStripOpen =
                        dimensionsEnabled && isInvoiceDoc && dimensionOverrideRows.has(index)
                      const accrualStripOpen =
                        canUseAccrual &&
                        item?.accrual_balance_account != null &&
                        (accrualRows.has(index) || Boolean(rowErrors?.accrual_period_end))
                      const canSaveAsArticle = canWrite && !item?.article_id && Boolean(rowDescription)
                      const articleAccount = item?.article_id
                        ? articles.find((a) => a.id === item.article_id)?.revenue_account ?? null
                        : null
                      const badges = item
                        ? rowOptionBadges(item, {
                            articleAccount,
                            isSelfBilled,
                            isInvoiceDoc,
                            dimensionsEnabled,
                            canUseAccrual,
                          })
                        : []
                      const badgeOpen = (badge: RowBadge) =>
                        badge.kind === 'discount'
                          ? discountStripOpen
                          : badge.kind === 'account'
                            ? accountStripOpen
                            : badge.kind === 'accrual'
                              ? accrualStripOpen
                              : dimensionStripOpen
                      const toggleBadge = (badge: RowBadge) => {
                        if (badge.kind === 'discount') toggleStripOpen(setDiscountRows, index)
                        else if (badge.kind === 'account') toggleStripOpen(setAccountOverrideRows, index)
                        else if (badge.kind === 'accrual') toggleStripOpen(setAccrualRows, index)
                        else toggleStripOpen(setDimensionOverrideRows, index)
                      }
                      const badgeLabel = (badge: RowBadge) =>
                        badge.kind === 'discount'
                          ? tForm('badge_discount', { percent: badge.percent })
                          : badge.kind === 'account'
                            ? tForm('badge_account', { account: badge.account })
                            : badge.kind === 'accrual'
                              ? badge.months !== null
                                ? tForm('badge_accrual_months', { months: badge.months })
                                : tForm('badge_accrual')
                              : tForm('badge_dimensions', { dims: badge.dims })
                      const deductionOptions: Array<'none' | DeductionType> = deductionsAvailable
                        ? ['none', 'rot', 'rut', 'gron_teknik']
                        : item?.deduction_type
                          ? ['none', item.deduction_type]
                          : ['none']
                      const canChangeVatInMenu =
                        vatRegistered && !showVatColumn && !vatRatePlan.isPickerLocked && vatRatePlan.options.length > 1

                      return (
                        <SortableRow
                          key={field.id}
                          value={field}
                          handleLabel={t('drag_handle_aria')}
                          disabled={fields.length === 1}
                        >
                          <div
                            id={`invoice-editor-row-${index}`}
                            className={cn('group border-b border-border', settleIndex === index && 'row-settle')}
                          >
                            <div className={cn(rowGridClass, 'py-1')}>
                              <div className="min-w-0">
                                <AutoGrowTextarea
                                  {...register(`items.${index}.description`)}
                                  placeholder={t('description_placeholder')}
                                  aria-label={t('description_label')}
                                  aria-invalid={rowErrors?.description ? true : undefined}
                                  className={cn(
                                    CELL_INPUT_CLASS,
                                    'w-full',
                                    rowErrors?.description && 'border-destructive',
                                  )}
                                />
                                {/* Every option set from the row menu shows
                                    here, so the menu is never the only sign;
                                    a badge folds its strip open or shut. */}
                                {badges.length > 0 && (
                                  <div className="flex flex-wrap gap-1 px-2 pb-1">
                                    {badges.map((badge) => (
                                      <button
                                        key={badge.kind}
                                        type="button"
                                        className={cn(badgeVariants({ variant: 'secondary' }), 'cursor-pointer tabular-nums hover:bg-secondary/60')}
                                        aria-expanded={badgeOpen(badge)}
                                        onClick={() => toggleBadge(badge)}
                                      >
                                        {badgeLabel(badge)}
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </div>
                              {/* Antal and Enhet: one cell. Free text with
                                  suggestions, not a closed list: any unit the
                                  API stores (an article imported as "l" or
                                  "m2") must be typable here and render as
                                  itself. */}
                              <div
                                className={cn(
                                  QTY_UNIT_CELL_CLASS,
                                  (rowErrors?.quantity || rowErrors?.unit) && 'border-destructive',
                                )}
                              >
                                <input
                                  type="number"
                                  step="0.01"
                                  inputMode="decimal"
                                  {...register(`items.${index}.quantity`, {
                                    valueAsNumber: true,
                                    onChange: () => followQuantity(index),
                                  })}
                                  aria-label={t('quantity_label')}
                                  aria-invalid={rowErrors?.quantity ? true : undefined}
                                  className={cn(QTY_UNIT_INPUT_CLASS, 'w-0 flex-1 pl-2 pr-1 text-right')}
                                />
                                <input
                                  data-cell="unit"
                                  list={UNIT_DATALIST_ID}
                                  maxLength={UNIT_MAX_LENGTH}
                                  {...register(`items.${index}.unit`, { onChange: () => followQuantity(index) })}
                                  aria-label={t('unit_label')}
                                  aria-invalid={rowErrors?.unit ? true : undefined}
                                  className={cn(QTY_UNIT_INPUT_CLASS, 'w-10 pr-2 text-muted-foreground')}
                                />
                              </div>
                              <input
                                type="number"
                                step="any"
                                inputMode="decimal"
                                {...register(`items.${index}.unit_price`, { valueAsNumber: true })}
                                aria-label={t('unit_price_label')}
                                aria-invalid={rowErrors?.unit_price ? true : undefined}
                                className={cn(
                                  CELL_INPUT_CLASS,
                                  'w-full text-right tabular-nums',
                                  rowErrors?.unit_price && 'border-destructive',
                                )}
                              />
                              {showVatColumn && (
                                <Controller
                                  name={`items.${index}.vat_rate`}
                                  control={control}
                                  render={({ field: vatField }) => (
                                    <Select
                                      value={String(vatField.value ?? 25)}
                                      onValueChange={(v) => vatField.onChange(Number(v))}
                                      disabled={vatRatePlan.isPickerLocked}
                                    >
                                      <SelectTrigger
                                        data-cell="vat_rate"
                                        className={CELL_SELECT_TRIGGER_CLASS}
                                        aria-label={t('vat_label')}
                                      >
                                        <SelectValue />
                                      </SelectTrigger>
                                      <SelectContent>
                                        {/* The lawful set, not the default one: a
                                            foreign business customer gets 0% first
                                            (and preselected) plus 25/12/6 for the
                                            supplies taxed where they are performed. */}
                                        {vatRatePlan.options.map((opt) => (
                                          <SelectItem key={opt.rate} value={String(opt.rate)}>
                                            {opt.label}
                                          </SelectItem>
                                        ))}
                                      </SelectContent>
                                    </Select>
                                  )}
                                />
                              )}
                              {showDeductionColumn && (
                                <DropdownMenu>
                                  <DropdownMenuTrigger asChild>
                                    <button
                                      type="button"
                                      data-cell="deduction"
                                      className={cn(DEDUCTION_CELL_CLASS, !item?.deduction_type && 'text-muted-foreground')}
                                      aria-label={tForm('deduction_column_aria')}
                                    >
                                      {item?.deduction_type === 'rot'
                                        ? 'ROT'
                                        : item?.deduction_type === 'rut'
                                          ? 'RUT'
                                          : item?.deduction_type === 'gron_teknik'
                                            ? tForm('deduction_short_gron')
                                            : tForm('deduction_short_none')}
                                      <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                                    </button>
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent align="end">
                                    <DropdownMenuLabel>{t('deduction_menu_label')}</DropdownMenuLabel>
                                    <DropdownMenuRadioGroup
                                      value={item?.deduction_type ?? 'none'}
                                      onValueChange={(v) => setRowDeduction(index, v === 'none' ? null : (v as DeductionType))}
                                    >
                                      {deductionOptions.map((option) => (
                                        <DropdownMenuRadioItem key={option} value={option} className="py-2">
                                          {option === 'none'
                                            ? t('deduction_none')
                                            : option === 'rot'
                                              ? t('deduction_rot')
                                              : option === 'rut'
                                                ? t('deduction_rut')
                                                : t('deduction_gron_teknik')}
                                        </DropdownMenuRadioItem>
                                      ))}
                                    </DropdownMenuRadioGroup>
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              )}
                              <div className="whitespace-nowrap px-1 text-right text-[13px] tabular-nums">
                                {formatCurrency(lineTotal, watchCurrency)}
                              </div>
                              <span className={cn('flex items-center justify-end', HOVER_REVEAL_CLASS)}>
                                <DropdownMenu>
                                  <DropdownMenuTrigger asChild>
                                    <button type="button" className={ROW_ICON_BUTTON_CLASS} aria-label={t('row_actions_aria')}>
                                      <MoreVertical className="h-4 w-4" />
                                    </button>
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent align="end" className="min-w-56">
                                    <DropdownMenuItem onSelect={() => toggleArticlePicker(index)} className="py-2">
                                      <Package className="h-4 w-4" />
                                      {t('row_menu_pick_article')}
                                    </DropdownMenuItem>
                                    {canSaveAsArticle && (
                                      <DropdownMenuItem
                                        onSelect={() => void saveLineAsArticle(index)}
                                        disabled={savingArticleIndex === index}
                                        className="py-2"
                                      >
                                        <Plus className="h-4 w-4" />
                                        {t('save_as_article')}
                                      </DropdownMenuItem>
                                    )}
                                    {!isSelfBilled && (
                                      <>
                                        <DropdownMenuSeparator />
                                        <DropdownMenuItem onSelect={() => toggleDiscount(index)} className="py-2">
                                          <Percent className="h-4 w-4" />
                                          {discountRows.has(index) || hasLineDiscount(item?.discount_percent)
                                            ? t('row_menu_remove_discount')
                                            : t('row_menu_add_discount')}
                                        </DropdownMenuItem>
                                      </>
                                    )}
                                    {/* Ändra moms: with the Moms column hidden
                                        (every row on the default), a rate is
                                        changed here; a different rate then
                                        brings the column in. */}
                                    {canChangeVatInMenu && (
                                      <>
                                        <DropdownMenuSeparator />
                                        <DropdownMenuLabel>{tForm('row_menu_change_vat')}</DropdownMenuLabel>
                                        <DropdownMenuRadioGroup
                                          value={String(item?.vat_rate ?? vatRatePlan.defaultRate)}
                                          onValueChange={(v) =>
                                            setValue(`items.${index}.vat_rate`, Number(v), { shouldDirty: true })
                                          }
                                        >
                                          {vatRatePlan.options.map((opt) => (
                                            <DropdownMenuRadioItem key={opt.rate} value={String(opt.rate)} className="py-2">
                                              {opt.label}
                                            </DropdownMenuRadioItem>
                                          ))}
                                        </DropdownMenuRadioGroup>
                                      </>
                                    )}
                                    {canUseAccrual && !item?.deduction_type && (
                                      <>
                                        <DropdownMenuSeparator />
                                        <DropdownMenuItem onSelect={() => toggleAccrual(index)} className="py-2">
                                          <CalendarClock className="h-4 w-4" />
                                          {item?.accrual_balance_account != null
                                            ? ta('row_menu_remove')
                                            : ta('row_menu_add')}
                                        </DropdownMenuItem>
                                      </>
                                    )}
                                    {isInvoiceDoc && (
                                      <>
                                        <DropdownMenuSeparator />
                                        <DropdownMenuItem onSelect={() => toggleAccountOverride(index)} className="py-2">
                                          <Landmark className="h-4 w-4" />
                                          {(accountOverrideRows.has(index) || item?.revenue_account)
                                            ? t('row_menu_remove_account')
                                            : t('row_menu_set_account')}
                                        </DropdownMenuItem>
                                      </>
                                    )}
                                    {dimensionsEnabled && isInvoiceDoc && (
                                      <>
                                        <DropdownMenuSeparator />
                                        <DropdownMenuItem onSelect={() => toggleItemDimensions(index)} className="py-2">
                                          <Tags className="h-4 w-4" />
                                          {(dimensionOverrideRows.has(index) || hasDimensionValues(item?.dimensions))
                                            ? t('row_menu_remove_dimensions')
                                            : t('row_menu_set_dimensions')}
                                        </DropdownMenuItem>
                                      </>
                                    )}
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem
                                      onSelect={() => remove(index)}
                                      className="py-2 text-destructive focus:text-destructive"
                                      aria-label={removeLabel}
                                    >
                                      <Trash2 className="h-4 w-4" />
                                      {tForm('row_menu_remove_row')}
                                    </DropdownMenuItem>
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              </span>
                            </div>

                            {rowErrorMsg && <p className="px-2 pb-2 text-xs text-destructive">{rowErrorMsg}</p>}
                            {savingArticleIndex === index && (
                              <p className="flex items-center gap-1 px-2 pb-2 text-xs text-muted-foreground">
                                <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                                {t('save_as_article')}
                              </p>
                            )}

                            {/* Article re-link strip (row ⋮ menu): article
                                selection stays reachable on every committed
                                row; "Egen rad" detaches the link. */}
                            {articleStripOpen && (
                              <div className="max-w-sm px-2 pb-3">
                                <Label className="mb-1 block text-xs text-muted-foreground">{t('article_label')}</Label>
                                <Controller
                                  name={`items.${index}.article_id`}
                                  control={control}
                                  render={({ field: articleField }) => (
                                    <ArticleCombobox
                                      value={articleField.value ?? null}
                                      articles={articles}
                                      onChange={(v) => {
                                        applyArticle(index, v)
                                        toggleArticlePicker(index)
                                      }}
                                      freeTextLabel={t('article_free_text')}
                                      placeholder={t('article_placeholder')}
                                      emptyLabel={t('article_search_empty')}
                                      ariaLabel={t('article_label')}
                                    />
                                  )}
                                />
                              </div>
                            )}

                            {/* Rabatt strip: opened via the ⋮ menu or the
                                row's Rabatt badge. */}
                            {discountStripOpen && (
                              <div className="px-2 pb-3">
                                <div className="flex flex-wrap items-center gap-2">
                                  <Label
                                    htmlFor={`invoice-line-discount-${index}`}
                                    className="text-xs text-muted-foreground"
                                  >
                                    {t('discount_label')}
                                  </Label>
                                  <div className="flex items-center gap-1">
                                    <Input
                                      id={`invoice-line-discount-${index}`}
                                      type="number"
                                      step="0.01"
                                      min={0}
                                      max={100}
                                      inputMode="decimal"
                                      placeholder="0"
                                      className="h-8 w-24 text-right tabular-nums"
                                      aria-label={t('discount_label')}
                                      aria-invalid={Boolean(rowErrors?.discount_percent) || undefined}
                                      {...register(`items.${index}.discount_percent`, {
                                        // valueAsNumber turns an emptied field into
                                        // NaN, which the schema rejects invisibly;
                                        // same pattern as labor_hours.
                                        setValueAs: (v) => {
                                          if (v === '' || v == null) return null
                                          const n = Number(v)
                                          return Number.isFinite(n) ? n : null
                                        },
                                      })}
                                    />
                                    <span className="text-xs text-muted-foreground">%</span>
                                  </div>
                                  {hasLineDiscount(item?.discount_percent) && (
                                    <span className="text-xs tabular-nums text-muted-foreground">
                                      &minus;{formatCurrency(
                                        roundOre((item?.quantity || 0) * (item?.unit_price || 0)) - lineTotal,
                                        watchCurrency,
                                      )}
                                    </span>
                                  )}
                                </div>
                                {rowErrors?.discount_percent && (
                                  <p className="mt-1 text-sm text-destructive">
                                    {rowErrors.discount_percent.message}
                                  </p>
                                )}
                              </div>
                            )}

                            {/* Periodisering (förutbetald intäkt): activated via
                                the row's ⋮ menu. */}
                            {accrualStripOpen && (
                              <div className="px-2 pb-3">
                                <AccrualPeriodControl
                                  direction="revenue"
                                  /* Entity type picks the regelverk the
                                     5 000 kr hint cites: K1 for enskild
                                     firma, K2 for aktiebolag. */
                                  entityType={company?.entity_type}
                                  amount={lineTotal}
                                  /* The customer-invoice editor carries no FX rate
                                     (the form has no exchange_rate field), so the
                                     currency alone is passed: it keeps the preview
                                     honest and suppresses the SEK-only K2 hint on
                                     foreign-currency lines. */
                                  currency={watchCurrency}
                                  idPrefix={`accrual-invoice-${index}`}
                                  value={{
                                    start: item?.accrual_period_start ?? '',
                                    end: item?.accrual_period_end ?? '',
                                    balanceAccount:
                                      item?.accrual_balance_account || DEFAULT_DEFERRED_REVENUE_ACCOUNT,
                                  }}
                                  onChange={(next) => {
                                    setValue(`items.${index}.accrual_period_start`, next.start, { shouldDirty: true })
                                    setValue(`items.${index}.accrual_period_end`, next.end, { shouldDirty: true })
                                    setValue(`items.${index}.accrual_balance_account`, next.balanceAccount, { shouldDirty: true })
                                  }}
                                  onRemove={() => toggleAccrual(index)}
                                />
                                {errors.items?.[index]?.accrual_period_end && (
                                  <p className="mt-1 text-sm text-destructive">
                                    {errors.items[index].accrual_period_end?.message}
                                  </p>
                                )}
                              </div>
                            )}

                            {/* Optional posting-account override (engångsartikel). */}
                            {accountStripOpen && (
                              <div className="px-2 pb-3">
                                <div className="max-w-sm space-y-1">
                                  <Label className="text-xs text-muted-foreground">{t('revenue_account_label')}</Label>
                                  <Controller
                                    name={`items.${index}.revenue_account`}
                                    control={control}
                                    render={({ field: accountField }) => (
                                      <AccountCombobox
                                        value={accountField.value ?? ''}
                                        accounts={postingAccounts}
                                        onChange={(v) => accountField.onChange(v || null)}
                                      />
                                    )}
                                  />
                                  {errors.items?.[index]?.revenue_account && (
                                    <p className="text-sm text-destructive">
                                      {errors.items[index].revenue_account?.message}
                                    </p>
                                  )}
                                </div>
                                <p className="mt-1 text-xs text-muted-foreground">{t('revenue_account_hint')}</p>
                              </div>
                            )}

                            {/* Per-item dimensions override (row ⋮ menu). */}
                            {dimensionStripOpen && (
                              <div className="px-2 pb-3">
                                <div className="max-w-md">
                                  <LineDimensionFields
                                    dimensions={item?.dimensions ?? undefined}
                                    onChange={(dimNo, code) => updateItemDimension(index, dimNo, code)}
                                    inputClassName="h-8"
                                  />
                                </div>
                                {hasDimensionValues(defaultDims) && (
                                  <p className="mt-1 text-xs text-muted-foreground">
                                    {t('row_dimensions_inherit_hint', { dims: compactDimensions(defaultDims) })}
                                  </p>
                                )}
                              </div>
                            )}
                          </div>
                        </SortableRow>
                      )
                    })}
                  </Reorder.Group>

                  {/* Unified entry row: never part of the field array until
                      committed (sort_order and the index-keyed override sets
                      stay stable). Ghost cells preview the append defaults. */}
                  <div className="flex">
                    <div className="w-8 shrink-0" aria-hidden="true" />
                    <div className={cn(rowGridClass, 'flex-1 border-b border-border py-1')}>
                      <input
                        ref={entryInputRef}
                        value={entryQuery}
                        onChange={(e) => {
                          setEntryQuery(e.target.value)
                          setEntryActiveIdx(-1)
                          if (!entryOpen) setEntryOpen(true)
                        }}
                        onFocus={() => setEntryOpen(true)}
                        onBlur={(e) => {
                          // Never close while focus stays inside the entry row
                          // and its popover: a tap on a suggestion or a ghost
                          // cell would otherwise unmount its own target before
                          // the commit ran (issue #2447). relatedTarget is
                          // null on several touch browsers, hence the
                          // activeElement re-check after the delay.
                          const next = e.relatedTarget as Node | null
                          if (next && entryRootRef.current?.contains(next)) return
                          window.setTimeout(() => {
                            if (entryRootRef.current?.contains(document.activeElement)) return
                            setEntryOpen(false)
                            setEntryActiveIdx(-1)
                          }, 250)
                        }}
                        onKeyDown={handleEntryKeyDown}
                        onKeyUp={handleEntryKeyUp}
                        placeholder={t('entry_placeholder')}
                        // Labels the Android action key as the commit, instead
                        // of the newline the free-text field otherwise implies.
                        enterKeyHint="done"
                        autoComplete="off"
                        role="combobox"
                        aria-expanded={entryOpen}
                        aria-controls={entryOpen ? entryListId : undefined}
                        aria-autocomplete="list"
                        aria-activedescendant={
                          entryOpen && entryActiveIdx >= 0 && entryMatches[entryActiveIdx]
                            ? `${entryListId}-opt-${entryActiveIdx}`
                            : undefined
                        }
                        aria-label={t('entry_aria')}
                        aria-describedby={entryOpen ? `${entryListId}-hint` : undefined}
                        className={cn(CELL_INPUT_CLASS, 'w-full')}
                      />
                      {/* Ghost cells are tap targets (issues #2481, #2447): a
                          tap births the row and lands in that cell. tabIndex
                          -1 keeps Tab on the description input; pointerdown,
                          like the suggestion buttons, so the entry input's
                          blur never races the commit, and so touch and pen
                          fire it natively instead of waiting for a
                          synthesized mouse event that arrives too late. */}
                      <div className="flex items-center justify-end">
                        <button
                          type="button"
                          tabIndex={-1}
                          aria-label={t('quantity_label')}
                          className={cn(ENTRY_GHOST_CLASS, 'w-0 flex-1 pr-1 text-right')}
                          onPointerDown={(e) => {
                            if (e.pointerType === 'mouse' && e.button !== 0) return
                            e.preventDefault()
                            commitEntryToCell(entryQuery.trim(), 'quantity')
                          }}
                        >
                          1
                        </button>
                        <button
                          type="button"
                          tabIndex={-1}
                          aria-label={t('unit_label')}
                          className={cn(ENTRY_GHOST_CLASS, 'w-10 pl-0 text-left')}
                          onPointerDown={(e) => {
                            if (e.pointerType === 'mouse' && e.button !== 0) return
                            e.preventDefault()
                            commitEntryToCell(entryQuery.trim(), 'unit')
                          }}
                        >
                          st
                        </button>
                      </div>
                      <button
                        type="button"
                        tabIndex={-1}
                        aria-label={t('unit_price_label')}
                        className={cn(ENTRY_GHOST_CLASS, 'w-full text-right')}
                        onPointerDown={(e) => {
                          if (e.pointerType === 'mouse' && e.button !== 0) return
                          e.preventDefault()
                          commitEntryToCell(entryQuery.trim(), 'unit_price')
                        }}
                      >
                        0
                      </button>
                      {showVatColumn && (
                        <button
                          type="button"
                          tabIndex={-1}
                          aria-label={t('vat_label')}
                          className={cn(ENTRY_GHOST_CLASS, 'whitespace-nowrap')}
                          onPointerDown={(e) => {
                            if (e.pointerType === 'mouse' && e.button !== 0) return
                            e.preventDefault()
                            commitEntryToCell(entryQuery.trim(), 'vat_rate')
                          }}
                        >
                          {vatRatePlan.defaultRate} %
                        </button>
                      )}
                      {showDeductionColumn && <div />}
                      <div />
                      <div />
                    </div>
                  </div>
                </div>
              </div>

              {/* Suggestion popover: anchored below the whole table wrap so it
                  never clips inside the horizontal scroll container. */}
              {entryOpen && (
                <div className={cn('absolute left-0 right-0 top-full z-30 mt-1 overflow-hidden', POPOVER_SURFACE_CLASS, POPOVER_ENTER_CLASS)}>
                  {/* The hint is a sibling of the listbox (listbox children
                      must be options); the input references it via
                      aria-describedby. */}
                  <div id={entryListId} role="listbox" className="max-h-72 overflow-y-auto">
                    {entryMatches.map((a, i) => (
                      <button
                        key={a.id}
                        id={`${entryListId}-opt-${i}`}
                        type="button"
                        role="option"
                        aria-selected={i === entryActiveIdx}
                        tabIndex={-1}
                        className={cn(
                          'flex w-full items-baseline justify-between gap-3 px-3 py-2 text-left',
                          i === entryActiveIdx ? 'bg-secondary/60' : 'hover:bg-secondary/60',
                        )}
                        onPointerDown={(e) => {
                          // pointerdown, not mousedown: on touch the
                          // synthesized mouse event arrives after the blur
                          // has already unmounted this listbox (issue #2447).
                          if (e.pointerType === 'mouse' && e.button !== 0) return
                          e.preventDefault()
                          commitEntryArticle(a.id)
                        }}
                        onMouseEnter={() => setEntryActiveIdx(i)}
                      >
                        <span className="text-[13px]">
                          {a.article_number ? `${a.article_number}: ${a.name}` : a.name}
                        </span>
                        <span className="whitespace-nowrap text-xs text-muted-foreground tabular-nums">
                          {formatCurrency(Number(a.price_excl_vat) || 0, (a.currency as Currency) || watchCurrency)}/{a.unit || 'st'} &middot; {a.vat_rate} %
                        </span>
                      </button>
                    ))}
                  </div>
                  <div
                    id={`${entryListId}-hint`}
                    className={cn(
                      'px-3 py-2 text-[11px] text-muted-foreground',
                      // Border only when a list renders above; alone it reads
                      // as a stray hairline at the top of the popover.
                      entryMatches.length > 0 && 'border-t border-border',
                    )}
                  >
                    {entryMatches.length > 0 ? t('entry_hint_matches') : t('entry_hint_free')}
                  </div>
                </div>
              )}
            </div>

            {itemsRootMsg && <p className="mt-2 text-sm text-destructive">{itemsRootMsg}</p>}

            {/* The keyboard-free way into a row (issue #2447): Android has
                no Tab and an IME can eat Enter, so the entry row must also be
                reachable by tapping something that says so. */}
            <div className="mt-3 flex flex-wrap items-center gap-4">
              <button type="button" className={ADD_ROW_LINK_CLASS} onClick={addEntryRow}>
                + {t('add_row')}
              </button>
              {!isSelfBilled && (
                <button type="button" className={ADD_ROW_LINK_CLASS} onClick={addTextRow}>
                  + {t('add_text_row')}
                </button>
              )}
            </div>

            {/* ===== Summering: right under the rows; a följesedel has none ===== */}
            {watchDocumentType !== 'delivery_note' && (
              <dl className="ml-auto mt-6 grid w-full max-w-xs grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-1 text-[13px] tabular-nums">
                <dt className="text-muted-foreground">{t('subtotal_label')}</dt>
                <dd className="text-right">{formatCurrency(subtotal, watchCurrency)}</dd>
                {/* VAT rows: only when momsregistrerad. A non-registered company
                    shows no moms line at all (subtotal === total). */}
                {vatRegistered &&
                  Array.from(vatByRate.entries())
                    .sort(([a], [b]) => b - a)
                    .map(([rate, group]) => (
                      <Fragment key={rate}>
                        {vatByRate.size > 1 && (
                          <>
                            <dt className="text-muted-foreground">{t('net_at_rate', { rate })}</dt>
                            <dd className="text-right">{formatCurrency(group.base, watchCurrency)}</dd>
                          </>
                        )}
                        {group.vat > 0 && (
                          <>
                            <dt className="text-muted-foreground">{t('vat_at_rate', { rate })}</dt>
                            <dd className="text-right">{formatCurrency(group.vat, watchCurrency)}</dd>
                          </>
                        )}
                      </Fragment>
                    ))}
                {vatRegistered && vatByRate.size === 0 && (
                  <>
                    <dt className="text-muted-foreground">{t('vat_label_short')}</dt>
                    <dd className="text-right">{formatCurrency(0, watchCurrency)}</dd>
                  </>
                )}
                {/* Öresavrundning, per invoice: only when the total has öre
                    to round (SEK). Display only: the invoice keeps its öre. */}
                {potentialRounding.applies && (
                  <>
                    <dt className="flex items-center gap-2 text-muted-foreground">
                      <label htmlFor="ore-rounding">{t('ore_rounding_label')}</label>
                      {!isSelfBilled && (
                        <Switch
                          id="ore-rounding"
                          checked={oreRounding}
                          onCheckedChange={setOreRounding}
                          aria-label={t('ore_rounding_label')}
                        />
                      )}
                    </dt>
                    <dd className="text-right">
                      {formatCurrency(displayRounding.applies ? displayRounding.roundingDelta : 0, watchCurrency)}
                    </dd>
                  </>
                )}
                {hasAnyDeduction && (
                  <>
                    <dt className="text-muted-foreground">{t('total_incl_vat_label')}</dt>
                    <dd className="text-right">{formatCurrency(total, watchCurrency)}</dd>
                    <dt className="text-muted-foreground">
                      {hasAnyGronTeknikLine ? t('deduction_summary_label_gron_teknik') : t('deduction_summary_label')}
                    </dt>
                    <dd className="text-right">&minus;{formatCurrency(deductionTotal, watchCurrency)}</dd>
                  </>
                )}
                <dt className="mt-2 border-t border-border pt-2 font-display text-xl">
                  {isInvoiceDoc || hasAnyDeduction ? t('to_pay_label') : isQuoteDoc ? tForm('sum_label') : t('total_label')}
                </dt>
                <dd className="mt-2 border-t border-border pt-2 text-right font-display text-xl">
                  {formatCurrency(displayedToPay, watchCurrency)}
                </dd>
              </dl>
            )}
          </EditorSection>

          {/* ===== Skattereduktion: with the first deduction row ===== */}
          {isInvoiceDoc && hasAnyDeduction && (
            <EditorSection
              label={tForm('deduction_title')}
              aside={
                <span className="inline-flex items-center gap-2">
                  {deductionAside}
                  <HelpPopover>
                    <div className="space-y-2">
                      <p>{t('deduction_card_description')}</p>
                      {hasAnyRotRutLine && <p>{t('deduction_labor_only_warning')}</p>}
                      {hasAnyGronTeknikLine && <p>{t('deduction_gron_teknik_base_hint')}</p>}
                    </div>
                  </HelpPopover>
                </span>
              }
            >
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="deduction_personnummer" className={FIELD_LABEL_CLASS}>
                    {t('deduction_personnummer_label')}
                    {!(initial?.deduction_personnummer_last4 || customerHasPersonalNumber) && <RequiredMark />}
                  </Label>
                  <Input
                    id="deduction_personnummer"
                    placeholder={customerMaskedPersonalNumber ?? t('deduction_personnummer_placeholder')}
                    autoComplete="off"
                    {...register('deduction_personnummer')}
                  />
                  <p className={FIELD_HINT_CLASS}>
                    {/* Stored pn exists only as ciphertext: an empty field on
                        edit keeps it server-side instead of failing validation.
                        Otherwise, a kundkort with a personnummer covers an
                        empty field via the server-side fallback. */}
                    {initial?.deduction_personnummer_last4
                      ? storedPersonnummerMasked
                        ? t('deduction_personnummer_kept_hint', { masked: storedPersonnummerMasked })
                        : t('deduction_personnummer_kept_hint_pending')
                      : customerHasPersonalNumber
                        ? t('deduction_personnummer_customer_hint')
                        : t('deduction_personnummer_hint')}
                  </p>
                </div>
                {(hasAnyRotLine || hasAnyGronTeknikLine) && (
                  <div className="space-y-2">
                    <Label htmlFor="deduction_housing_designation" className={FIELD_LABEL_CLASS}>
                      {t('deduction_housing_label')}
                      <RequiredMark />
                    </Label>
                    <Input
                      id="deduction_housing_designation"
                      placeholder={t('deduction_housing_placeholder')}
                      {...register('deduction_housing_designation')}
                    />
                  </div>
                )}
              </div>

              {/* Per row: the arbetstyp (installation for grön teknik) and
                  the hours Skatteverket's claim needs. */}
              {deductionRowIndexes.map((index) => {
                const item = watchItems[index]
                const isGronTeknik = item?.deduction_type === 'gron_teknik'
                const options: ReadonlyArray<{ code: string; label: string }> = isGronTeknik
                  ? GRON_TEKNIK_WORK_TYPES
                  : item?.deduction_type === 'rot' ? ROT_WORK_TYPES : RUT_WORK_TYPES
                const workPlaceholder = isGronTeknik
                  ? t('deduction_gron_teknik_work_type_placeholder')
                  : t('deduction_work_type_placeholder')
                const amount = computeDeduction({
                  unit_price: item?.unit_price || 0,
                  quantity: item?.quantity || 0,
                  discount_percent: item?.discount_percent,
                  deduction_type: item?.deduction_type,
                  work_type: item?.work_type,
                  vat_rate: vatRegistered ? (item?.vat_rate ?? (vatRules?.rate || 25)) : 0,
                })
                const hoursFromQuantity =
                  item?.labor_hours != null && defaultLaborHours(item) === item.labor_hours
                const rowErr = errors.items?.[index]
                return (
                  <div
                    key={fields[index]?.id ?? index}
                    id={`invoice-editor-deduction-${index}`}
                    className="mt-4 border-t border-border pt-4"
                  >
                    {deductionRowIndexes.length > 1 && (
                      <p className="mb-2 truncate text-[12.5px] text-muted-foreground" data-ph-mask="">
                        {item?.description?.trim() || t('row_label', { index: index + 1 })}
                      </p>
                    )}
                    <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_8rem]">
                      <div className="min-w-0 space-y-2">
                        <Label className={FIELD_LABEL_CLASS}>
                          {isGronTeknik ? tForm('deduction_installation_label') : tForm('deduction_work_label')}
                          <RequiredMark />
                        </Label>
                        <Controller
                          name={`items.${index}.work_type`}
                          control={control}
                          render={({ field: workField }) => (
                            <Select value={workField.value ?? ''} onValueChange={(v) => workField.onChange(v || null)}>
                              <SelectTrigger
                                aria-label={workPlaceholder}
                                aria-invalid={Boolean(rowErr?.work_type) || undefined}
                              >
                                <SelectValue placeholder={workPlaceholder} />
                              </SelectTrigger>
                              <SelectContent>
                                {options.map((w) => (
                                  <SelectItem key={w.code} value={w.code}>
                                    {w.label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          )}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor={`labor-hours-${index}`} className={FIELD_LABEL_CLASS}>
                          {t('deduction_hours_placeholder')}
                        </Label>
                        <Input
                          id={`labor-hours-${index}`}
                          type="number"
                          step="0.5"
                          inputMode="decimal"
                          className="text-right tabular-nums"
                          aria-invalid={Boolean(rowErr?.labor_hours) || undefined}
                          {...register(`items.${index}.labor_hours`, {
                            // valueAsNumber would override setValueAs and
                            // turn an emptied field into NaN, which the
                            // schema rejects with no visible error.
                            setValueAs: (v) => {
                              if (v === '' || v == null) return null
                              const n = Number(v)
                              return Number.isFinite(n) ? n : null
                            },
                            // A typed value is the user's: it stops following the quantity.
                            onChange: () => {
                              const id = fields[index]?.id
                              if (id) autoHoursRef.current.delete(id)
                            },
                          })}
                        />
                        {hoursFromQuantity && <p className={FIELD_HINT_CLASS}>{tForm('hours_from_quantity')}</p>}
                      </div>
                    </div>
                    {amount > 0 && (
                      <p className={cn(FIELD_HINT_CLASS, 'mt-2 tabular-nums')}>
                        {tForm('deduction_row_amount', { amount: formatCurrency(amount, watchCurrency) })}
                      </p>
                    )}
                    {(rowErr?.work_type || rowErr?.labor_hours || rowErr?.deduction_type) && (
                      <p className="mt-1 text-sm text-destructive">
                        {rowErr?.work_type?.message ?? rowErr?.labor_hours?.message ?? rowErr?.deduction_type?.message}
                      </p>
                    )}
                  </div>
                )
              })}

              {capWarnings.length > 0 && (
                <div className="mt-4 space-y-1 rounded-lg border border-border px-3 py-2 text-[12.5px] text-muted-foreground">
                  {capWarnings.map((w) => (
                    <p key={w}>{w}</p>
                  ))}
                </div>
              )}
            </EditorSection>
          )}

          {/* ===== Anteckning: one line that grows ===== */}
          <EditorSection
            label={tForm('note_title')}
            aside={isQuoteDoc ? tForm('note_aside_quote') : tForm('note_aside')}
          >
            <AutoGrowTextarea
              {...register('notes')}
              placeholder={tForm('note_placeholder')}
              aria-label={tForm('note_title')}
              className={NOTE_INPUT_CLASS}
            />
          </EditorSection>

          {/* ===== Betalning: one summary line, the panel behind "Ändra" ===== */}
          {paymentSummary && (
            <EditorSection
              id="invoice-editor-payment"
              label={tForm('payment_title')}
              aside={paymentOverridden ? tForm('payment_aside_invoice') : tForm('payment_aside_settings')}
            >
              <PaymentSummary
                parts={describeEditorPaymentSummary(paymentSummary)}
                missingDetails={paymentSummary.payeeMissing && !paymentSummary.storedAccountUsable}
                reason={paymentReason(paymentSummary, {
                  lang: documentLanguage,
                  showOcr: companySettings?.invoice_show_ocr ?? true,
                })}
                terms={paymentTermsTexts(companySettings)}
                canEditCompany={isCompanyAdmin && canWrite}
                addForm={
                  addingPayee ? (
                    <BankDetailsSetupForm
                      onComplete={() => void handleBankSetupComplete()}
                      onCancel={() => {
                        setAddingPayee(false)
                        setQueuedIntent(null)
                      }}
                    />
                  ) : null
                }
                onAddDetails={() => setAddingPayee(true)}
                onOpenPanel={() => {
                  setPaymentPanelScope(isCompanyAdmin && canWrite ? 'all' : 'this')
                  setPaymentPanelOpen(true)
                }}
              />
            </EditorSection>
          )}

          {/* The status line lives under the preview; at narrow widths the
              form shows alone, so it follows the form there. A received
              självfaktura has no preview: it always sits here. */}
          {renderStatusLine(isSelfBilled ? '' : '@min-[900px]:hidden')}
        </div>
      </form>
      }
    />

      <SendConfirmDialog
        open={confirmIntent !== null && confirmData !== null}
        onOpenChange={(open) => {
          if (open) return
          setConfirmIntent(null)
          setSwedishVatAcknowledged(false)
        }}
        title={confirmTitle}
        rows={confirmRows}
        voucher={confirmVoucher}
        extra={
          // Swedish VAT to an EU customer whose reverse charge is blocked
          // needs the explicit tick before the invoice exists (#2749).
          selectedCustomer && vatWarnings.length > 0 ? (
            <div className="space-y-3">
              <VatTreatmentNotice
                tone="muted"
                customer={selectedCustomer}
                lineVatRates={effectiveLineVatRates}
                onValidated={handleCustomerVatValidated}
              />
              {needsSwedishVatAcknowledgement && (
                <div className="flex items-start gap-2">
                  <Checkbox
                    id="swedish-vat-acknowledged"
                    checked={swedishVatAcknowledged}
                    onCheckedChange={(checked) => setSwedishVatAcknowledged(checked === true)}
                    className="mt-0.5"
                  />
                  <Label htmlFor="swedish-vat-acknowledged" className="text-[13px] font-normal leading-5">
                    {tVat('acknowledge_swedish_vat')}
                  </Label>
                </div>
              )}
            </div>
          ) : null
        }
        confirmLabel={confirmLabel}
        confirmDisabled={confirmDisabled}
        busy={isSubmitting}
        onConfirm={() => {
          if (confirmIntent?.kind === 'create') void createWithoutSending()
          else if (confirmIntent?.kind === 'send') void sendFromEditor(confirmIntent.channel)
        }}
      />

      {/* Create customer dialog */}
      <Dialog open={isCreateCustomerOpen} onOpenChange={setIsCreateCustomerOpen}>
        <DialogContent className="sm:max-w-2xl max-h-[95dvh] sm:max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('create_customer_dialog_title')}</DialogTitle>
          </DialogHeader>
          <CustomerForm
            onSubmit={handleCreateCustomer}
            isLoading={isCreatingCustomer}
            initialData={createCustomerPrefill ? { name: createCustomerPrefill } : undefined}
          />
        </DialogContent>
      </Dialog>

      {/* First-invoice logo prompt (issue #520) */}
      <FirstInvoiceLogoPrompt
        open={showLogoPrompt}
        onClose={handleLogoPromptClose}
        logoUrl={logoUrl}
        onLogoUpdate={(url) => setLogoUrl(url)}
      />

    </>
  )
}
