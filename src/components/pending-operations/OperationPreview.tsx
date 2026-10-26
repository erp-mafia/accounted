'use client'

// The one pending-op-owned preview (flows prereq, seam 8.3): renders what a
// staged pending_operation will do, dispatched on operation_type. Consumed by
// /pending (list detail + confirm dialogs), the chat ApprovalCard, and future
// flow-run views. Renderers moved verbatim from app/(dashboard)/pending/page.tsx;
// keep markup and classNames in lockstep with the design system, not with any
// one consumer.

import { Fragment, createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { ArrowDown } from 'lucide-react'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { isUuid } from '@/lib/invariants/uuid'
import { AttnLine } from '@/components/ui/attn-line'
import { Skeleton } from '@/components/ui/skeleton'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import type { PendingOperation } from '@/types'
import { DEDUCTION_TYPE_LABELS, isDeductionType } from '@/lib/bookkeeping/rot-rut-rules'
import { isRegisterBookedInvoiceParams } from '@/lib/invoices/register-booked-invoice-mode'
import { AttachDocumentPreview } from '@/components/bookkeeping/AttachDocumentPreview'
import { MatchTransactionInvoicePreview } from '@/components/bookkeeping/MatchTransactionInvoicePreview'
import { LinkDocumentsPreview } from './LinkDocumentsPreview'
import { ReconciliationMatchPreview, hasReconciliationMatchDetails } from './ReconciliationMatchPreview'
import { PurchaseCategoryPreview } from './PurchaseCategoryPreview'
import { DocumentViewButton } from '@/components/bookkeeping/DocumentViewButton'
import { VoucherLinesTable } from '@/components/bookkeeping/VoucherLinesTable'
import { voucherLineViews, type PostingLineLike } from '@/lib/bookkeeping/voucher-line-view'
import DocumentViewerPane from '@/components/bookkeeping/DocumentViewerPane'
import { complianceWarningOf, type ComplianceWarning } from './vocabulary'
import { formatPreviewNumber } from './preview-facts'

// The subset of a PendingOperation the preview actually reads. operation_type
// is widened to string: the chat surface derives it from an MCP tool name and
// unknown values legitimately fall through to GenericPreview. params carries
// tool inputs some renderers need (e.g. attach_document_to_transaction's
// document_id); surfaces that only have preview_data may omit it.
export interface OperationPreviewInput {
  operation_type: string
  preview_data: PendingOperation['preview_data']
  params?: PendingOperation['params']
}

/**
 * Account number -> account name, for the proposal previews. The value is
 * provided by whichever page owns the fetch lifecycle (/pending provides a
 * per-mount, per-company map; a consumer that provides nothing gets the
 * default {} and previews show the bare number, never a wrong name).
 */
export const AccountNamesContext = createContext<Record<string, string>>({})

/** Render '-' instead of "NaN kr" when a preview payload omits an amount. */
function money(v: unknown, currency: string): string {
  return typeof v === 'number' && Number.isFinite(v) ? formatCurrency(v, currency) : '-'
}

function CategorizePreview({ data }: { data: Record<string, unknown> }) {
  // The exact journal lines the approval will post (net cost line, VAT line,
  // gross bank line, SEK): staged by the server since the preview-lines fix.
  const lines = (data.lines as Array<{ account_number?: string; debit_amount?: number; credit_amount?: number; description?: string }>) || []
  const vatLines = (data.vat_lines as Array<{ account_number: string; debit_amount: number; credit_amount: number; description: string }>) || []

  if (lines.length > 0) {
    // Journal lines are always SEK (BFL 5 kap 2 §). When the bank row itself
    // is in another currency, say so next to the lines: a 2 500 USD receipt
    // booked as 24 292,50 kr read as a wrong SEK figure to an approver who
    // only saw one of the two numbers.
    const txCurrency = (data.currency as string) || 'SEK'
    const txAmount = typeof data.amount === 'number' && Number.isFinite(data.amount) ? data.amount : null
    return (
      <div className="space-y-1 text-sm">
        {/* Entry date first: with two open fiscal years the approver could
            not tell which year a categorization belonged to. */}
        {typeof data.date === 'string' && data.date && (
          <div className="flex justify-between gap-4 text-xs mb-1">
            <span className="text-muted-foreground">Datum</span>
            <span className="font-mono tabular-nums">{data.date}</span>
          </div>
        )}
        <p className="text-xs text-muted-foreground mb-1">Verifikat</p>
        {txCurrency !== 'SEK' && txAmount !== null && (
          <div className="flex justify-between gap-4 text-xs text-muted-foreground mb-1">
            <span>Banktransaktion</span>
            <span className="tabular-nums shrink-0">{formatCurrency(txAmount, txCurrency)}</span>
          </div>
        )}
        <StagedLinesTable lines={lines} />
      </div>
    )
  }

  // Some operations carry their kontering under the generic `preview_lines`
  // key instead (the shape every other staged type renders through). Read it
  // before falling through to the legacy summary, which would otherwise show
  // blank accounts for a preview that does describe the entry in full.
  if (isKonteringLines(data.preview_lines)) {
    return (
      <div className="space-y-1 text-sm">
        <p className="text-xs text-muted-foreground mb-1">Verifikat</p>
        <PreviewKonteringTable lines={data.preview_lines} />
      </div>
    )
  }

  // Legacy summary for operations staged before the preview carried full
  // lines: debit/credit accounts + gross amount + separate VAT rows.
  const legacyAmount = typeof data.amount === 'number' && Number.isFinite(data.amount)
    ? data.amount
    : null
  return (
    <div className="space-y-3 text-sm">
      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        <span className="text-muted-foreground">Debetkonto</span>
        <span className="font-mono">{String(data.debit_account ?? '')}</span>
        <span className="text-muted-foreground">Kreditkonto</span>
        <span className="font-mono">{String(data.credit_account ?? '')}</span>
        <span className="text-muted-foreground">Belopp</span>
        <span className="font-mono tabular-nums">
          {/* A preview with no usable amount used to render "NaN kr": show the
              gap as a gap instead of a number that isn't one. */}
          {legacyAmount === null
            ? '-'
            : formatCurrency(legacyAmount, (data.currency as string) || 'SEK')}
        </span>
      </div>
      {vatLines.length > 0 && (
        <div className="border-t pt-2">
          <p className="text-xs text-muted-foreground mb-1">Momsrader</p>
          <StagedLinesTable lines={vatLines} />
        </div>
      )}
    </div>
  )
}

function CustomerPreview({ data }: { data: Record<string, unknown> }) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
      <span className="text-muted-foreground">Namn</span>
      <span>{String(data.name ?? '')}</span>
      <span className="text-muted-foreground">Typ</span>
      <span>{String(data.customer_type ?? '')}</span>
      {data.customer_number ? (
        <>
          <span className="text-muted-foreground">Kundnr</span>
          <span className="font-mono">{String(data.customer_number)}</span>
        </>
      ) : null}
      {data.email ? (
        <>
          <span className="text-muted-foreground">E-post</span>
          <span>{String(data.email)}</span>
        </>
      ) : null}
      {data.org_number ? (
        <>
          <span className="text-muted-foreground">Org.nr</span>
          <span className="font-mono">{String(data.org_number)}</span>
        </>
      ) : null}
      {data.personal_number_masked ? (
        <>
          <span className="text-muted-foreground">Personnr</span>
          <span className="font-mono">{String(data.personal_number_masked)}</span>
        </>
      ) : null}
    </div>
  )
}

// One staged (or replaced) invoice line as the staging tools put it in
// preview_data: create_invoice and update_invoice both carry the effective
// vat_rate and any posting-account override, so a rebooking is visible to the
// approver, not only the amount (issue #1642).
interface PreviewInvoiceLine {
  description: string
  quantity: number
  unit: string
  unit_price?: number
  line_total: number
  vat_rate?: number
  revenue_account?: string | null
  article_id?: string | null
  line_type?: string
  // ROT/RUT and periodisering markers: a full replace that drops one of
  // these must be visible to the approver, not only the amounts.
  deduction_type?: string | null
  accrual_period_start?: string | null
  accrual_period_end?: string | null
}

function isPreviewInvoiceLines(value: unknown): value is PreviewInvoiceLine[] {
  return (
    Array.isArray(value) &&
    value.every((row) => row != null && typeof row === 'object' && typeof (row as PreviewInvoiceLine).description === 'string')
  )
}

function InvoiceLineRows({ items, currency }: { items: PreviewInvoiceLine[]; currency: string }) {
  return (
    <div className="space-y-1">
      {items.map((item, i) => (
        <div key={i} className="flex justify-between text-xs">
          <span className="truncate mr-4">
            {item.description}
            {item.line_type === 'text' ? null : ` (${item.quantity} ${item.unit})`}
            {typeof item.vat_rate === 'number' && item.line_type !== 'text' && (
              <span className="text-muted-foreground"> · {item.vat_rate} % moms</span>
            )}
            {item.revenue_account && (
              <span className="text-muted-foreground font-mono"> · {item.revenue_account}</span>
            )}
            {item.deduction_type && (
              <span className="text-muted-foreground">
                {' · '}
                {isDeductionType(item.deduction_type) ? DEDUCTION_TYPE_LABELS[item.deduction_type].ledger : 'skattereduktion'}
              </span>
            )}
            {item.accrual_period_start && item.accrual_period_end && (
              <span className="text-muted-foreground"> · periodiseras {item.accrual_period_start} till {item.accrual_period_end}</span>
            )}
          </span>
          <span className="font-mono tabular-nums whitespace-nowrap">
            {item.line_type === 'text' ? '' : money(item.line_total, currency)}
          </span>
        </div>
      ))}
    </div>
  )
}

// The staging tools' VAT-treatment explanation (explainVatTreatment): why an
// EU customer got Swedish VAT, or a Swedish rate on a reverse-charge invoice.
// Rendered as the card's one ochre sentence per warning; the list is at most
// one entry today. Older ops without the field render unchanged.
interface PreviewVatWarning {
  code: string
  message_sv: string
}

function readVatWarnings(value: unknown): PreviewVatWarning[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (row): row is PreviewVatWarning =>
      row != null && typeof row === 'object' && typeof (row as PreviewVatWarning).message_sv === 'string',
  )
}

function VatWarningLines({ data }: { data: Record<string, unknown> }) {
  const warnings = readVatWarnings(data.vat_warnings)
  if (warnings.length === 0) return null
  return (
    <>
      {warnings.map((warning) => (
        <AttnLine key={warning.code}>{warning.message_sv}</AttnLine>
      ))}
    </>
  )
}

function InvoicePreview({ data }: { data: Record<string, unknown> }) {
  const items = isPreviewInvoiceLines(data.items) ? data.items : []

  return (
    <div className="space-y-3 text-sm">
      <VatWarningLines data={data} />
      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        <span className="text-muted-foreground">Kund</span>
        <span>{String(data.customer_name ?? '')}</span>
        <span className="text-muted-foreground">Datum</span>
        <span>{String(data.invoice_date ?? '')}</span>
        <span className="text-muted-foreground">Förfallodatum</span>
        <span>{String(data.due_date ?? '')}</span>
      </div>
      {items.length > 0 && (
        <div className="border-t pt-2">
          <InvoiceLineRows items={items} currency={(data.currency as string) || 'SEK'} />
        </div>
      )}
      <div className="border-t pt-2 grid grid-cols-2 gap-x-4 gap-y-1">
        <span className="text-muted-foreground">Netto</span>
        <span className="tabular-nums text-right">{money(data.subtotal, (data.currency as string) || 'SEK')}</span>
        <span className="text-muted-foreground">Moms</span>
        <span className="tabular-nums text-right">{money(data.vat_amount, (data.currency as string) || 'SEK')}</span>
        <span className="font-medium">Totalt</span>
        <span className="tabular-nums font-medium text-right">{money(data.total, (data.currency as string) || 'SEK')}</span>
      </div>
    </div>
  )
}

/**
 * A create_invoice staged by gnubok_register_booked_invoice (crm#1094):
 * nothing is posted and there are no draft lines, so what the approver checks
 * is which invoice it is, the verifikat it is tied to and what is left to pay.
 */
function RegisterBookedInvoicePreview({ data }: { data: Record<string, unknown> }) {
  const t = useTranslations('pending')
  const currency = (data.currency as string) || 'SEK'
  const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value : '-')
  const date = (value: unknown) => (typeof value === 'string' && value ? formatDate(value) : '-')
  const voucher = [text(data.voucher_label), typeof data.voucher_date === 'string' && data.voucher_date ? formatDate(data.voucher_date) : null]
    .filter(Boolean)
    .join(', ')

  return (
    <div className="space-y-3 text-sm">
      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        <span className="text-muted-foreground">{t('preview_field.customer_name')}</span>
        <span className="min-w-0 break-words">{text(data.customer_name)}</span>
        <span className="text-muted-foreground">{t('preview_field.invoice_number')}</span>
        <span className="font-mono tabular-nums">{text(data.invoice_number)}</span>
        <span className="text-muted-foreground">{t('preview_field.invoice_date')}</span>
        <span className="tabular-nums">{date(data.invoice_date)}</span>
        <span className="text-muted-foreground">{t('preview_field.due_date')}</span>
        <span className="tabular-nums">{date(data.due_date)}</span>
        <span className="text-muted-foreground">{t('preview_field.voucher_label')}</span>
        <span className="tabular-nums">{voucher}</span>
        {typeof data.voucher_description === 'string' && data.voucher_description.trim() && (
          <>
            <span className="text-muted-foreground">{t('preview_field.voucher_description')}</span>
            <span className="min-w-0 break-words">{data.voucher_description}</span>
          </>
        )}
      </div>
      <div className="border-t pt-2 grid grid-cols-2 gap-x-4 gap-y-1">
        <span className="text-muted-foreground">{t('preview_field.vat_amount')}</span>
        <span className="tabular-nums text-right">{money(data.vat_amount, currency)}</span>
        <span className="text-muted-foreground">{t('preview_field.total')}</span>
        <span className="tabular-nums text-right">{money(data.total, currency)}</span>
        {/* A foreign invoice: the rate read from its verifikat, and the kronor that verifikat books. */}
        {typeof data.exchange_rate === 'number' && (
          <>
            <span className="text-muted-foreground">{t('preview_field.exchange_rate')}</span>
            <span className="tabular-nums text-right">
              {new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 6 }).format(data.exchange_rate)} ({money(data.total_sek, 'SEK')})
            </span>
          </>
        )}
        <span className="font-medium">{t('preview_field.invoice_remaining')}</span>
        <span className="tabular-nums font-medium text-right">{money(data.remaining_amount, currency)}</span>
        {typeof data.balance_as_of === 'string' && data.balance_as_of && (
          <>
            <span className="text-muted-foreground">{t('preview_field.balance_as_of')}</span>
            <span className="tabular-nums text-right">{formatDate(data.balance_as_of)}</span>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * The same for a create_supplier_invoice_from_inbox staged by
 * gnubok_register_booked_supplier_invoice: the invoice takes the verifikat's
 * own rows, so they show as that verifikat's lines, captioned as booked
 * already, never as a kontering about to be posted.
 */
function RegisterBookedSupplierInvoicePreview({ data }: { data: Record<string, unknown> }) {
  const t = useTranslations('pending')
  const currency = (data.currency as string) || 'SEK'
  const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value : '-')
  const date = (value: unknown) => (typeof value === 'string' && value ? formatDate(value) : '-')
  const voucher = [text(data.voucher_label), typeof data.voucher_date === 'string' && data.voucher_date ? formatDate(data.voucher_date) : null]
    .filter(Boolean)
    .join(', ')
  const voucherLinesCaption = t('preview_registered_voucher_lines')

  return (
    <div className="space-y-3 text-sm">
      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        <span className="text-muted-foreground">{t('preview_field.supplier_name')}</span>
        <span className="min-w-0 break-words">{text(data.supplier_name)}</span>
        <span className="text-muted-foreground">{t('preview_field.supplier_invoice_number')}</span>
        <span className="font-mono tabular-nums">{text(data.supplier_invoice_number)}</span>
        {typeof data.payment_reference === 'string' && data.payment_reference.trim() && (
          <>
            <span className="text-muted-foreground">{t('preview_field.payment_reference')}</span>
            <span className="min-w-0 break-words font-mono tabular-nums">{data.payment_reference}</span>
          </>
        )}
        {typeof data.arrival_number === 'number' && (
          <>
            <span className="text-muted-foreground">{t('preview_field.arrival_number')}</span>
            <span className="font-mono tabular-nums">{data.arrival_number}</span>
          </>
        )}
        <span className="text-muted-foreground">{t('preview_field.invoice_date')}</span>
        <span className="tabular-nums">{date(data.invoice_date)}</span>
        <span className="text-muted-foreground">{t('preview_field.due_date')}</span>
        <span className="tabular-nums">{date(data.due_date)}</span>
        <span className="text-muted-foreground">{t('preview_field.voucher_label')}</span>
        <span className="tabular-nums">{voucher}</span>
        {typeof data.voucher_description === 'string' && data.voucher_description.trim() && (
          <>
            <span className="text-muted-foreground">{t('preview_field.voucher_description')}</span>
            <span className="min-w-0 break-words">{data.voucher_description}</span>
          </>
        )}
      </div>
      {isKonteringLines(data.voucher_lines) && (
        <div className="space-y-1 border-t pt-2">
          <p className="text-xs text-muted-foreground">{voucherLinesCaption}</p>
          <PreviewKonteringTable lines={data.voucher_lines} label={voucherLinesCaption} />
        </div>
      )}
      <div className="border-t pt-2 grid grid-cols-2 gap-x-4 gap-y-1">
        <span className="text-muted-foreground">{t('preview_field.subtotal')}</span>
        <span className="tabular-nums text-right">{money(data.subtotal, currency)}</span>
        <span className="text-muted-foreground">{t('preview_field.vat_amount')}</span>
        <span className="tabular-nums text-right">{money(data.vat_amount, currency)}</span>
        <span className="text-muted-foreground">{t('preview_field.total')}</span>
        <span className="tabular-nums text-right">{money(data.total, currency)}</span>
        <span className="font-medium">{t('preview_field.invoice_remaining')}</span>
        <span className="tabular-nums font-medium text-right">{money(data.invoice_remaining, currency)}</span>
        {typeof data.balance_as_of === 'string' && data.balance_as_of && (
          <>
            <span className="text-muted-foreground">{t('preview_field.balance_as_of')}</span>
            <span className="tabular-nums text-right">{formatDate(data.balance_as_of)}</span>
          </>
        )}
      </div>
    </div>
  )
}

const UPDATE_INVOICE_FIELD_LABELS: Record<string, string> = {
  notes: 'Anteckningar',
  invoice_date: 'Fakturadatum',
  due_date: 'Förfallodatum',
  delivery_date: 'Leveransdatum',
  your_reference: 'Er referens',
  our_reference: 'Vår referens',
}

function UpdateInvoicePreview({ data }: { data: Record<string, unknown> }) {
  const currency = (data.currency as string) || 'SEK'
  const changes = (data.changes && typeof data.changes === 'object' ? (data.changes as Record<string, unknown>) : {})
  const headerEntries = Object.entries(changes).filter(
    ([key, value]) => key !== 'items' && key !== 'default_dimensions' && value !== undefined,
  )
  const hasDimensionChange = 'default_dimensions' in changes
  const dimensionBag = changes.default_dimensions as Record<string, string> | undefined
  const newItems = isPreviewInvoiceLines(data.items) ? data.items : null
  const currentItems = isPreviewInvoiceLines(data.current_items) ? data.current_items : null

  return (
    <div className="space-y-3 text-sm">
      <VatWarningLines data={data} />
      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        <span className="text-muted-foreground">Kund</span>
        <span>{String(data.customer_name ?? '')}</span>
        <span className="text-muted-foreground">Faktura</span>
        <span>{data.invoice_number ? String(data.invoice_number) : 'utkast'}</span>
        {headerEntries.map(([key, value]) => (
          <Fragment key={key}>
            <span className="text-muted-foreground">{UPDATE_INVOICE_FIELD_LABELS[key] ?? key.replace(/_/g, ' ')}</span>
            {/* null is an explicit clear (delivery_date: null), not a missing value */}
            <span>{value === null ? 'rensas' : renderValue(value)}</span>
          </Fragment>
        ))}
        {hasDimensionChange && (
          <>
            <span className="text-muted-foreground">Dimensioner</span>
            <span className="font-mono text-xs">
              {dimensionBag && Object.keys(dimensionBag).length > 0
                ? Object.entries(dimensionBag).map(([dim, code]) => `${dim}: ${code}`).join(', ')
                : 'rensas'}
            </span>
          </>
        )}
      </div>
      {/* Full replace: show what goes away next to what comes in, so a
          quantity fix that also moves revenue off the article's account
          (3041 to 3001) or changes the VAT rate is visible before approval. */}
      {currentItems && (
        <div className="border-t pt-2 space-y-1">
          <div className="text-xs text-muted-foreground">
            {currentItems.length > 0 ? 'Nuvarande rader (ersätts)' : 'Nuvarande rader: inga'}
          </div>
          {currentItems.length > 0 && <InvoiceLineRows items={currentItems} currency={currency} />}
        </div>
      )}
      {newItems && (
        <div className="border-t pt-2 space-y-1">
          <div className="text-xs text-muted-foreground">Nya rader</div>
          <InvoiceLineRows items={newItems} currency={currency} />
        </div>
      )}
      {newItems && typeof data.total === 'number' && (
        <div className="border-t pt-2 grid grid-cols-2 gap-x-4 gap-y-1">
          <span className="text-muted-foreground">Netto</span>
          <span className="tabular-nums text-right">{money(data.subtotal, currency)}</span>
          <span className="text-muted-foreground">Moms</span>
          <span className="tabular-nums text-right">{money(data.vat_amount, currency)}</span>
          <span className="font-medium">Totalt</span>
          <span className="tabular-nums font-medium text-right">{money(data.total, currency)}</span>
        </div>
      )}
    </div>
  )
}

function CreateTransactionPreview({ data }: { data: Record<string, unknown> }) {
  const currency = (data.currency as string) || 'SEK'

  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
      <span className="text-muted-foreground">Datum</span>
      <span className="font-mono">{String(data.date ?? '')}</span>
      <span className="text-muted-foreground">Beskrivning</span>
      <span className="truncate">{String(data.description ?? '')}</span>
      <span className="text-muted-foreground">Belopp</span>
      <span className="font-mono tabular-nums">
        {money(data.amount, currency)}
      </span>
      {data.external_id ? (
        <>
          <span className="text-muted-foreground">Extern referens</span>
          <span className="font-mono text-xs truncate">{String(data.external_id)}</span>
        </>
      ) : null}
    </div>
  )
}

// Staged or posted lines through the shared VoucherLinesTable, named from
// this card's AccountNamesContext and never the active company's chart: the
// operation may be another company's. voucherLineViews reads every line shape
// the payloads use (account/debit/credit and account_number/debit_amount/
// credit_amount).

function StagedLinesTable({
  lines,
  showTotals = false,
  label,
}: {
  lines: readonly PostingLineLike[]
  showTotals?: boolean
  label?: string
}) {
  const accountNames = useContext(AccountNamesContext)
  return (
    <VoucherLinesTable
      accountNames={accountNames}
      withCurrency
      showTotals={showTotals}
      aria-label={label}
      lines={voucherLineViews(lines)}
    />
  )
}

// The verifikat's kontering with, when known, its sums: the staged lines of
// create_voucher and a toEntryPreview payload, and the posted lines a
// link_document_to_voucher review fetches.
function VoucherLinesBlock({
  lines,
  totalDebit,
  totalCredit,
}: {
  lines: PostingLineLike[]
  totalDebit?: number
  totalCredit?: number
}) {
  if (lines.length === 0) return null
  return <StagedLinesTable lines={lines} showTotals={totalDebit != null && totalCredit != null} />
}

// The momsdeklaration impact a staged create_voucher carries (crm#1447):
// server-built Swedish, like the ruta labels it names. Shown when the
// declaration leaves the voucher out, when it moves a ruta, when the outcome
// waits for posting, or when it could not be computed; silent when the
// voucher moves no ruta or the company files no momsdeklaration.
function readVatDeclarationSummary(value: unknown): string | null {
  if (!isPlainObject(value)) return null
  const { summary, status, counted, rutor_change: change } = value
  if (typeof summary !== 'string' || summary === '' || status === 'not_vat_registered') return null
  const moves = isPlainObject(change) && Object.keys(change).length > 0
  if (status === 'ok' && counted === true && !moves) return null
  return summary
}

// showSeries: false for a toEntryPreview payload, which carries no series;
// the engine picks it per source type at commit, so defaulting to A here
// would state a series the verifikat may not get. The missing-underlag
// warning (BFL 5 kap 6 §) is read by complianceWarningOf and rendered by
// OperationPreview above every preview type, not here.
function VoucherPreview({ data, showSeries = true }: { data: Record<string, unknown>; showSeries?: boolean }) {
  const t = useTranslations('pending')
  const lines = (data.lines as PostingLineLike[]) || []
  const totalDebit = data.total_debit as number | undefined
  const totalCredit = data.total_credit as number | undefined
  const vatSummary = readVatDeclarationSummary(data.vat_declaration)

  return (
    <div className="space-y-3 text-sm">
      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        {/* A lines-only payload (mark_invoice_paid's journal_entry_preview)
            has no date or text of its own: no empty rows for them. */}
        {data.entry_date ? (
          <>
            <span className="text-muted-foreground">Datum</span>
            <span className="font-mono">{String(data.entry_date)}</span>
          </>
        ) : null}
        {data.description ? (
          <>
            <span className="text-muted-foreground">Beskrivning</span>
            <span className="truncate">{String(data.description)}</span>
          </>
        ) : null}
        {showSeries && (
          <>
            <span className="text-muted-foreground">Serie</span>
            <span className="font-mono">{String(data.voucher_series ?? 'A')}</span>
          </>
        )}
        {vatSummary ? (
          <>
            <span className="text-muted-foreground">{t('preview_vat_declaration')}</span>
            <span>{vatSummary}</span>
          </>
        ) : null}
      </div>
      <VoucherLinesBlock lines={lines} totalDebit={totalDebit} totalCredit={totalCredit} />
    </div>
  )
}

function BulkBookPreview({ data }: { data: Record<string, unknown> }) {
  // Samlingsverifikat over N bank rows. The staged kontering IS what the RPC
  // posts on approval, so it is the load-bearing part of this card; the
  // aggregates alone ("-720, 2 tx, expense") cannot tell a right booking from
  // a wrong one. Journal lines are SEK; the bank sum is shown in the rows'
  // own currency so a foreign batch is never misread as SEK.
  const lines = (data.lines as PostingLineLike[]) || []
  const txCount = typeof data.tx_count === 'number' ? data.tx_count : null
  const txSum = typeof data.tx_sum === 'number' && Number.isFinite(data.tx_sum) ? data.tx_sum : null
  const currency = (data.currency as string) || 'SEK'
  const linkExisting = data.mode === 'link_existing'
  const t = useTranslations('pending')
  // A link may carry rows of several dates: earliest and latest.
  const txDate = String(data.tx_date ?? '')
  const txDates = data.tx_date_to
    ? t('preview_field.date_range', { from: txDate, to: String(data.tx_date_to) })
    : txDate

  return (
    <div className="space-y-3 text-sm">
      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        <span className="text-muted-foreground">Datum</span>
        <span className="font-mono">{txDates}</span>
        <span className="text-muted-foreground">Transaktioner</span>
        <span className="font-mono tabular-nums">
          {txCount ?? '-'}
          {txSum !== null ? ` · ${formatCurrency(txSum, currency)}` : ''}
        </span>
        <span className="text-muted-foreground">Åtgärd</span>
        <span>{linkExisting ? 'Länka till befintligt verifikat' : 'Ny samlingsverifikation'}</span>
        {data.entry_description ? (
          <>
            <span className="text-muted-foreground">Beskrivning</span>
            <span className="truncate">{String(data.entry_description)}</span>
          </>
        ) : null}
      </div>
      {lines.length > 0 && <StagedLinesTable lines={lines} showTotals />}
      {linkExisting && lines.length === 0 && (
        <p className="text-xs text-muted-foreground">
          Transaktionerna kopplas till ett redan bokfört verifikat; ingen ny kontering skapas.
        </p>
      )}
    </div>
  )
}

function CorrectEntryPreview({ data }: { data: Record<string, unknown> }) {
  const original = (data.original as {
    voucher?: string
    entry_date?: string
    description?: string
    lines?: PostingLineLike[]
  }) || {}
  const correction = (data.correction as {
    total_debit?: number
    total_credit?: number
    line_count?: number
    lines?: PostingLineLike[]
  }) || {}

  return (
    <div className="space-y-4 text-sm">
      <div>
        <p className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1">
          Originalverifikation V{original.voucher ?? ''}, {original.entry_date ?? ''}
        </p>
        <p className="text-xs text-muted-foreground italic mb-2">{original.description ?? ''}</p>
        {original.lines && original.lines.length > 0 && <StagedLinesTable lines={original.lines} />}
      </div>
      <div>
        <p className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1">
          Korrigerad verifikation ({correction.line_count ?? correction.lines?.length ?? 0} rader)
        </p>
        {correction.lines && correction.lines.length > 0 && (
          <StagedLinesTable lines={correction.lines} showTotals={correction.total_debit != null} />
        )}
      </div>
    </div>
  )
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

// Render a primitive (string/number/bool), a short summary of an array, or a
// nested object pretty-printed. Used by UpdateInvoicePreview's header fields
// (GenericPreview states only labelled plain values). A one-line
// JSON.stringify has almost no break opportunities, so it ran out of the
// dialog instead of wrapping.
function renderValue(value: unknown): ReactNode {
  if (value == null) return ''
  if (Array.isArray(value)) return `${value.length} rader`
  if (isPlainObject(value)) {
    return (
      <pre className="whitespace-pre-wrap break-words font-mono text-[12.5px]">
        {JSON.stringify(value, null, 2)}
      </pre>
    )
  }
  return String(value)
}

// A verifikat preview nested under a key: toEntryPreview's shape, which the
// deferred "Bokför" operations (supplier and customer invoices, VAT
// settlement, opening balances) stage as journal_entry. VoucherPreview
// already renders that shape, so it shows as the verifikat, not as its JSON.
function isEntryPreview(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value) || !Array.isArray(value.lines) || value.lines.length === 0) return false
  return value.lines.every(
    (line) =>
      isPlainObject(line) &&
      typeof line.account_number === 'string' &&
      typeof line.debit_amount === 'number' &&
      typeof line.credit_amount === 'number',
  )
}

// A preview_data value that is a kontering (array of account/debit/credit
// rows). Several staged op types carry one under keys like `preview_lines`
// without a dedicated preview component; rendering it as the actual
// verifikat rows is what makes the detail panel say what the agent will do.
function isKonteringLines(value: unknown): value is PostingLineLike[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (line) =>
        line != null &&
        typeof line === 'object' &&
        ('account' in line || 'account_number' in line) &&
        ('debit' in line || 'credit' in line || 'debit_amount' in line || 'credit_amount' in line),
    )
  )
}

function PreviewKonteringTable({ lines, label = 'Föreslagen kontering' }: { lines: PostingLineLike[]; label?: string }) {
  return <StagedLinesTable lines={lines} label={label} />
}

// Keys GenericPreview never lists as a row: period_status has its own banner
// and compliance_warning its own line above the preview (OperationPreview),
// so a row would state the same fact twice. registration_warnings are the
// agent's structured copy of a registration's compliance_warning (crm#1094).
const GENERIC_PREVIEW_SKIPPED_KEYS = new Set(['period_status', 'compliance_warning', 'registration_warnings'])

// One verifikat per row (journal_entries): each a toEntryPreview payload.
function isEntryPreviewList(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.length > 0 && value.every(isEntryPreview)
}

// A plain value the card can state on one line: text, a number, yes/no, or a
// list of texts. Objects and lists of objects are structure for the agent.
function isFactValue(value: unknown): value is string | number | boolean | string[] {
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'string' || typeof value === 'boolean') return true
  return Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string')
}

// A changed field as the supplier dry run stages it.
function isChangePair(value: unknown): value is { from: unknown; to: unknown } {
  return isPlainObject(value) && Object.keys(value).length === 2 && 'from' in value && 'to' in value
}

// An update's changes (crm#1300) as two readings of the record: before, what
// the staged preview says each field held, and after, with the changes
// applied. Staging tools say it two ways: a { from, to } pair per field
// (suppliers), or the stored record beside the changes, as current
// (accounts, customers, articles) or previous (company settings). A field
// missing from before was staged without its old value.
function readUpdate(data: Record<string, unknown>) {
  const changes = isPlainObject(data.changes) ? data.changes : {}
  const stored = isPlainObject(data.current) ? data.current : isPlainObject(data.previous) ? data.previous : {}
  const before: Record<string, unknown> = { ...stored }
  const after: Record<string, unknown> = { ...stored }
  for (const [field, value] of Object.entries(changes)) {
    if (isChangePair(value)) {
      before[field] = value.from
      after[field] = value.to
    } else {
      after[field] = value
    }
  }
  return { fields: Object.keys(changes), before, after }
}

// What an update replaces, struck, then what it becomes: the reading of the
// rättelse log on a verifikat.
function ValueChange({ before, after }: { before: ReactNode; after: ReactNode }) {
  return (
    <>
      <del className="text-muted-foreground">{before}</del>
      {' → '}
      <ins className="no-underline">{after}</ins>
    </>
  )
}

// Outside the detail panel (the chat card, the confirm dialog) a long list of
// verifikat stops after a few; the Granskning panel shows them all.
const ENTRY_LIST_COMPACT = 3

function GenericPreview({ data, detail = false }: { data: Record<string, unknown>; detail?: boolean }) {
  const t = useTranslations('pending')
  // A uuid is a database handle, not something the approver can check
  // against anything: the title already names the objects involved.
  const entries = Object.entries(data).filter(
    ([k, v]) => v != null && v !== '' && !GENERIC_PREVIEW_SKIPPED_KEYS.has(k) && !isUuid(v),
  )
  const entryPreviews = entries.filter(([, v]) => isEntryPreview(v))
  const entryLists = entries.filter(([, v]) => isEntryPreviewList(v))
  const konteringEntries = entries.filter(([, v]) => isKonteringLines(v))
  // preview_data keys are the staging tools' field names: a field shows only
  // under a preview_field label (sv and en), never as its raw key, and a
  // number shows as money when it is one (crm#1104). What the approval posts
  // is the verifikat above, from the executor's own builders.
  const stated = (v: unknown): v is string | number | boolean | string[] =>
    v != null && v !== '' && !isUuid(v) && isFactValue(v)
  const labelled = (obj: Record<string, unknown>) =>
    Object.entries(obj).filter(([k, v]) => stated(v) && t.has(`preview_field.${k}`)) as Array<
      [string, string | number | boolean | string[]]
    >
  const facts = labelled(Object.fromEntries(entries))
  // A labelled group shows its own labelled fields, one level down, instead
  // of a JSON dump of raw keys. An update's changes are the one group read
  // against what the record held, below.
  const groups = entries
    .filter(([k, v]) => k !== 'changes' && isPlainObject(v) && !isEntryPreview(v) && t.has(`preview_field.${k}`))
    .map(([k, v]) => [k, v as Record<string, unknown>, labelled(v as Record<string, unknown>)] as const)
    .filter(([, , rows]) => rows.length > 0)
  // Each changed field with what it held, when the preview says, so the
  // approver judges the change without opening the record (crm#1300). A
  // field cleared shows as a change when its old value is known.
  const update = readUpdate(data)
  const changeFields = update.fields.filter((field) => {
    const after = update.after[field]
    const cleared = after == null || after === ''
    return t.has(`preview_field.${field}`) && (stated(after) || (cleared && stated(update.before[field])))
  })
  const fact = (key: string, value: string | number | boolean | string[], scope: Record<string, unknown>): ReactNode => {
    if (typeof value === 'boolean') return value ? t('preview_yes') : t('preview_no')
    if (typeof value === 'number') return formatPreviewNumber(key, value, scope)
    // A code (customer_type: eu_business) reads as its word where one exists.
    if (typeof value === 'string' && t.has(`preview_value.${key}.${value}`)) return t(`preview_value.${key}.${value}`)
    return Array.isArray(value) ? value.join(', ') : value
  }
  const factRow = (key: string, value: string | number | boolean | string[], scope: Record<string, unknown>, nested = false) => (
    <Fragment key={key}>
      <span className={cn('min-w-0 break-words text-muted-foreground', nested && 'pl-3')}>{t(`preview_field.${key}`)}</span>
      <span className={cn('min-w-0 break-words', typeof value === 'number' && 'font-mono tabular-nums')}>
        {fact(key, value, scope)}
      </span>
    </Fragment>
  )
  // An empty or unreadable value (a dimension bag) shows as '-'.
  const changeValue = (field: string, value: unknown, scope: Record<string, unknown>): ReactNode =>
    stated(value) ? fact(field, value, scope) : '-'
  const changeRow = (field: string) => {
    const before = update.before[field]
    const after = update.after[field]
    const known = field in update.before && (stated(before) || before == null || before === '')
    const beforeScope = { ...data, ...update.before }
    const afterScope = { ...data, ...update.after }
    return (
      <Fragment key={field}>
        <span className="min-w-0 break-words pl-3 text-muted-foreground">{t(`preview_field.${field}`)}</span>
        <span className={cn('min-w-0 break-words', (typeof after === 'number' || typeof before === 'number') && 'font-mono tabular-nums')}>
          {known ? (
            <ValueChange before={changeValue(field, before, beforeScope)} after={changeValue(field, after, afterScope)} />
          ) : (
            changeValue(field, after, afterScope)
          )}
        </span>
      </Fragment>
    )
  }
  if (entryPreviews.length + entryLists.length + konteringEntries.length + facts.length + groups.length + changeFields.length === 0) {
    // An empty box under the title reads as "nothing to review". Say so.
    return <p className="text-sm text-muted-foreground">{t('preview_generic_none')}</p>
  }
  return (
    <div className="space-y-3">
      {entryPreviews.map(([key, value]) => (
        <VoucherPreview key={key} data={value as Record<string, unknown>} showSeries={false} />
      ))}
      {entryLists.map(([key, value]) => {
        const list = value as Record<string, unknown>[]
        const shown = detail ? list : list.slice(0, ENTRY_LIST_COMPACT)
        return (
          <div key={key} className="space-y-3">
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
              {t('preview_entries_heading', { count: list.length })}
            </p>
            {shown.map((entry, i) => (
              <div key={i} className={cn(i > 0 && 'border-t pt-3')}>
                <VoucherPreview data={entry} showSeries={false} />
              </div>
            ))}
            {shown.length < list.length && (
              <p className="text-xs text-muted-foreground">
                {t('preview_entries_more', { count: list.length - shown.length })}
              </p>
            )}
          </div>
        )
      })}
      {konteringEntries.map(([key, value]) => (
        <PreviewKonteringTable key={key} lines={value as PostingLineLike[]} />
      ))}
      {facts.length + groups.length + changeFields.length > 0 && (
        <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-x-4 gap-y-1 text-sm">
          {facts.map(([key, value]) => factRow(key, value, data))}
          {groups.map(([key, obj, rows]) => (
            <Fragment key={key}>
              <span className="col-span-2 pt-1 text-muted-foreground">{t(`preview_field.${key}`)}</span>
              {rows.map(([k, v]) => factRow(k, v, { ...data, ...obj }, true))}
            </Fragment>
          ))}
          {changeFields.length > 0 && (
            <>
              <span className="col-span-2 pt-1 text-muted-foreground">{t('preview_field.changes')}</span>
              {changeFields.map(changeRow)}
            </>
          )}
        </div>
      )}
    </div>
  )
}

// update_account stages { account_number, current, changes }: the stored row
// and the fields the edit sets. One "before → after" row per changed field,
// instead of two JSON objects the approver has to diff by eye.
function UpdateAccountPreview({ data }: { data: Record<string, unknown> }) {
  const t = useTranslations('pending')
  const tAccounts = useTranslations('chart_of_accounts')
  const current = isPlainObject(data.current) ? data.current : {}
  const changes = isPlainObject(data.changes) ? data.changes : {}
  const label = (field: string) =>
    t.has(`preview_account_${field}`) ? t(`preview_account_${field}`) : field.replace(/_/g, ' ')
  const show = (field: string, value: unknown): string => {
    // null or '' clears the field (back to the BAS default where one exists).
    if (value == null || value === '') return '-'
    if (typeof value === 'boolean') return value ? t('preview_yes') : t('preview_no')
    if (field === 'default_vat_rate' && typeof value === 'number') {
      return `${Math.round(value * 10000) / 100} %`
    }
    if (field === 'default_vat_treatment' && tAccounts.has(`vat_treatment_${value}`)) {
      return tAccounts(`vat_treatment_${value}`)
    }
    return String(value)
  }
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
      <span className="text-muted-foreground">{t('preview_account')}</span>
      <span className="min-w-0 break-words">
        <span className="font-mono tabular-nums">{String(data.account_number ?? '')}</span>
        {current.account_name ? ` ${String(current.account_name)}` : null}
      </span>
      {Object.entries(changes).map(([field, value]) => (
        <Fragment key={field}>
          <span className="text-muted-foreground">{label(field)}</span>
          <span className="min-w-0 break-words">
            <ValueChange before={show(field, current[field])} after={show(field, value)} />
          </span>
        </Fragment>
      ))}
    </div>
  )
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/**
 * The posted lines of the verifikat a link_document_to_voucher review points
 * at, fetched when the review opens. The staged preview carries the voucher's
 * label, date and text but not its kontering, and the kontering is what tells
 * whether the document belongs to it. The result is tagged with the id it
 * belongs to, so a slow answer for the previous review never renders under
 * the next one (the DocumentViewerPane idiom).
 */
function useVoucherLines(journalEntryId: string | null) {
  const [fetched, setFetched] = useState<{ id: string; lines: PostingLineLike[] | null } | null>(null)
  useEffect(() => {
    if (!journalEntryId) return
    let cancelled = false
    fetch(`/api/bookkeeping/journal-entries/${journalEntryId}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { data?: { lines?: unknown } } | null) => {
        if (cancelled) return
        const raw = body?.data?.lines
        const lines = Array.isArray(raw)
          ? (raw as Array<Record<string, unknown>>)
              .slice()
              .sort((a, b) => Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0))
              .map((line) => ({
                account_number: String(line.account_number ?? ''),
                debit_amount: Number(line.debit_amount) || 0,
                credit_amount: Number(line.credit_amount) || 0,
                line_description: readString(line.line_description),
              }))
          : null
        setFetched({ id: journalEntryId, lines })
      })
      .catch(() => {
        if (!cancelled) setFetched({ id: journalEntryId, lines: null })
      })
    return () => {
      cancelled = true
    }
  }, [journalEntryId])
  const current = fetched?.id === journalEntryId ? fetched : null
  return { loading: journalEntryId != null && current == null, lines: current?.lines ?? null }
}

function LinkPreviewCard({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-2 rounded-lg border border-border p-3">
      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
      {children}
    </div>
  )
}

function LinkPreviewRows({ rows }: { rows: Array<{ label: string; value: ReactNode; tabular?: boolean }> }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-3 gap-y-1">
      {rows.map((row) => (
        <Fragment key={row.label}>
          <span className="text-xs text-muted-foreground">{row.label}</span>
          <span className={cn('min-w-0 break-words', row.tabular && 'tabular-nums')}>{row.value}</span>
        </Fragment>
      ))}
    </div>
  )
}

/**
 * link_document_to_voucher, the most staged operation type: a document is
 * attached to an already posted verifikat. It fell through to GenericPreview,
 * which printed the staging tool's field names ("voucher date", "document
 * currently linked to other") and raw values ("posted", "false") (crm#1003).
 *
 * `detail` is the Granskning drawer: there the review also shows the
 * verifikat's kontering and the document itself, so the approver can tell
 * what is being linked without leaving the view. The confirm dialog and the
 * chat card stay compact (no fetch, no embedded document).
 */
function LinkDocumentToVoucherPreview({
  data,
  params,
  detail,
}: {
  data: Record<string, unknown>
  params: Record<string, unknown>
  detail: boolean
}) {
  const t = useTranslations('pending')
  const tStatus = useTranslations('journal_status')
  const documentId = isUuid(params.document_id) ? params.document_id : null
  const journalEntryId = isUuid(params.journal_entry_id) ? params.journal_entry_id : null
  const fileName = readString(data.document_file_name)
  const mimeType = readString(data.document_mime_type)
  const voucherLabel = readString(data.voucher_label)
  const voucherDate = readString(data.voucher_date)
  const voucherText = readString(data.voucher_description)
  const voucherStatus = readString(data.voucher_status)
  const statusLabel =
    voucherStatus && tStatus.has(`status_${voucherStatus}`) ? tStatus(`status_${voucherStatus}`) : voucherStatus
  const { loading: linesLoading, lines } = useVoucherLines(detail ? journalEntryId : null)

  const voucherRows = [
    { label: t('preview_link_number'), value: voucherLabel ?? '-', tabular: true },
    { label: t('preview_link_date'), value: voucherDate ? formatDate(voucherDate) : '-', tabular: true },
    ...(voucherText ? [{ label: t('preview_link_description'), value: voucherText }] : []),
    ...(statusLabel ? [{ label: t('preview_link_status'), value: statusLabel }] : []),
  ]

  const voucherCard = (
    <LinkPreviewCard label={t('preview_link_voucher_heading')}>
      <LinkPreviewRows rows={voucherRows} />
      {detail && journalEntryId && (
        <div className="space-y-2 pt-1">
          {linesLoading ? (
            <div className="space-y-1.5">
              <Skeleton className="h-4 w-full rounded-sm" />
              <Skeleton className="h-4 w-full rounded-sm" />
            </div>
          ) : lines && lines.length > 0 ? (
            <StagedLinesTable lines={lines} showTotals />
          ) : (
            <p className="text-xs text-muted-foreground">{t('preview_link_lines_failed')}</p>
          )}
          <Link href={`/bookkeeping/${journalEntryId}`} className={QUIET_LINK_CLASS}>
            {t('preview_link_open_voucher')}
          </Link>
        </div>
      )}
    </LinkPreviewCard>
  )

  const showViewer = detail && documentId != null
  const documentCard = (
    <LinkPreviewCard label={t('preview_link_document_heading')}>
      {/* The viewer's own header names the file. */}
      {!showViewer && <LinkPreviewRows rows={[{ label: t('preview_link_file'), value: fileName ?? '-' }]} />}
      {data.document_already_linked === true && (
        <p className="text-xs text-muted-foreground">{t('preview_link_already_linked')}</p>
      )}
      {data.document_currently_linked_to_other === true && (
        <p className="text-xs text-attn">{t('preview_link_linked_elsewhere')}</p>
      )}
      {documentId &&
        (showViewer ? (
          <DocumentViewerPane
            documentId={documentId}
            mime={mimeType}
            fileName={fileName}
            className="h-[56vh]"
          />
        ) : (
          <div className="pt-1">
            <DocumentViewButton documentId={documentId} />
          </div>
        ))}
    </LinkPreviewCard>
  )

  if (detail) {
    return (
      <div className="space-y-3 text-sm">
        {voucherCard}
        {documentCard}
      </div>
    )
  }
  return (
    <div className="space-y-3 text-sm">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {voucherCard}
        {documentCard}
      </div>
      <div className="flex items-center justify-center text-xs text-muted-foreground">
        <ArrowDown className="mr-1 h-3.5 w-3.5" aria-hidden />
        {t('preview_link_caption')}
      </div>
    </div>
  )
}

/** The warning as the approver reads it: the UI's own words where the UI owns them. */
export function useComplianceWarningText(): (warning: ComplianceWarning) => string {
  const t = useTranslations('pending')
  return (warning) => (warning.kind === 'missing_underlag' ? t('warning_missing_underlag') : warning.text)
}

export function OperationPreview({ op, detail = false }: { op: OperationPreviewInput; detail?: boolean }) {
  const warningText = useComplianceWarningText()
  const warning = complianceWarningOf(op)
  const body = (() => {
    switch (op.operation_type) {
      case 'categorize_transaction':
        return <CategorizePreview data={op.preview_data} />
      case 'create_customer':
        return <CustomerPreview data={op.preview_data} />
      case 'create_invoice':
        return isRegisterBookedInvoiceParams(op.preview_data)
          ? <RegisterBookedInvoicePreview data={op.preview_data} />
          : <InvoicePreview data={op.preview_data} />
      case 'create_supplier_invoice_from_inbox':
        return isRegisterBookedInvoiceParams(op.preview_data)
          ? <RegisterBookedSupplierInvoicePreview data={op.preview_data} />
          : <GenericPreview data={op.preview_data} />
      case 'update_invoice':
        return <UpdateInvoicePreview data={op.preview_data} />
      case 'create_transaction':
        return <CreateTransactionPreview data={op.preview_data} />
      case 'create_voucher':
        return <VoucherPreview data={op.preview_data} />
      case 'bulk_book_transactions':
        return <BulkBookPreview data={op.preview_data} />
      case 'correct_entry':
        return <CorrectEntryPreview data={op.preview_data} />
      case 'update_account':
        return <UpdateAccountPreview data={op.preview_data} />
      case 'attach_document_to_transaction':
        return <AttachDocumentPreview data={op.preview_data} params={op.params ?? {}} detail={detail} />
      case 'match_transaction_invoice':
        return <MatchTransactionInvoicePreview data={op.preview_data} />
      case 'link_documents_to_vouchers':
        return <LinkDocumentsPreview data={op.preview_data} />
      case 'link_document_to_voucher':
        return <LinkDocumentToVoucherPreview data={op.preview_data} params={op.params ?? {}} detail={detail} />
      case 'reconciliation_match':
        // An operation staged before the pairs were described (crm#1147)
        // carries ids only: it keeps the generic preview.
        return hasReconciliationMatchDetails(op.preview_data)
          ? <ReconciliationMatchPreview data={op.preview_data} detail={detail} />
          : <GenericPreview data={op.preview_data} detail={detail} />
      case 'set_inbox_purchase_category':
        return <PurchaseCategoryPreview data={op.preview_data} />
      default:
        return <GenericPreview data={op.preview_data} detail={detail} />
    }
  })()
  // One line above every preview type, from the same reading the Granskning
  // row uses. The VAT explanation stays inside the invoice previews, next to
  // the lines it is about.
  if (!warning || warning.kind === 'vat') return body
  return (
    <div className="space-y-3">
      <AttnLine className="break-words">{warningText(warning)}</AttnLine>
      {body}
    </div>
  )
}
