'use client'

// The one pending-op-owned preview (flows prereq, seam 8.3): renders what a
// staged pending_operation will do, dispatched on operation_type. Consumed by
// /pending (list detail + confirm dialogs), the chat ApprovalCard, and future
// flow-run views. Renderers moved verbatim from app/(dashboard)/pending/page.tsx;
// keep markup and classNames in lockstep with the design system, not with any
// one consumer.

import { Fragment, createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { ArrowDownIcon } from '@/components/icons'
import { cn, formatAmount, formatCurrency, formatDate } from '@/lib/utils'
import { isUuid } from '@/lib/invariants/uuid'
import { isLedgerCurrency } from '@/lib/bookkeeping/currency-utils'
import { AttnLine } from '@/components/ui/attn-line'
import { LateReveal, Skeleton } from '@/components/ui/skeleton'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import type { PendingOperation } from '@/types'
import { DEDUCTION_TYPE_LABELS, isDeductionType } from '@/lib/bookkeeping/rot-rut-rules'
import { isRegisterBookedInvoiceParams } from '@/lib/invoices/register-booked-invoice-mode'
import { AttachDocumentPreview } from '@/components/bookkeeping/AttachDocumentPreview'
import { MatchTransactionInvoicePreview } from '@/components/bookkeeping/MatchTransactionInvoicePreview'
import { LinkDocumentsPreview } from './LinkDocumentsPreview'
import { ReconciliationMatchPreview, hasReconciliationMatchDetails } from './ReconciliationMatchPreview'
import { PurchaseCategoryPreview } from './PurchaseCategoryPreview'
import { ProposalDocument } from './ProposalDocument'
import { proposalDocumentRef } from './proposal-document'
import { DocumentViewButton } from '@/components/bookkeeping/DocumentViewButton'
import { VoucherLinesTable } from '@/components/bookkeeping/VoucherLinesTable'
import { voucherLineViews, type PostingLineLike } from '@/lib/bookkeeping/voucher-line-view'
import DocumentViewerPane from '@/components/bookkeeping/DocumentViewerPane'
import { complianceWarningOf, type ComplianceWarning } from './vocabulary'
import { formatPreviewNumber } from './preview-facts'
import { Fact, FactGroupLabel, FactList, FactRows, PreviewBlock, PreviewDensityContext, ReviewTitleContext, useIsTemplate } from './preview-parts'
import { VTD_CLASS, VTH_CLASS } from '@/components/ui/dry-table'
import { proposalFacts, voucherFacts } from './review-model'
import type { VoucherWarning } from '@/lib/bookkeeping/voucher-plausibility'

// The subset of a PendingOperation the preview actually reads. operation_type
// is widened to string: the chat surface derives it from an MCP tool name and
// unknown values legitimately fall through to GenericPreview. params carries
// tool inputs some renderers need (e.g. attach_document_to_transaction's
// document_id); surfaces that only have preview_data may omit it. status
// lets a resolved removal stop pointing at a file that may be gone.
export interface OperationPreviewInput {
  operation_type: string
  preview_data: PendingOperation['preview_data']
  params?: PendingOperation['params']
  status?: string
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
  const template = useIsTemplate()
  // The exact journal lines the approval will post (net cost line, VAT line,
  // gross bank line, SEK): staged by the server since the preview-lines fix.
  const lines = (data.lines as Array<{ account_number?: string; debit_amount?: number; credit_amount?: number; description?: string }>) || []
  const vatLines = (data.vat_lines as Array<{ account_number: string; debit_amount: number; credit_amount: number; description: string }>) || []
  // Entry date first, then (for a bank row in another currency) its own
  // amount beside the SEK lines: review-model's categorizeFacts.
  const facts = proposalFacts('categorize_transaction', data) ?? []
  // The template heads the block itself ("Det här bokförs").
  const caption = template ? null : <p className="text-xs text-muted-foreground mb-1">Verifikat</p>

  if (lines.length > 0) {
    return (
      <div className="space-y-2 text-sm">
        <FactRows groups={facts} />
        {caption}
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
      <div className="space-y-2 text-sm">
        {caption}
        <PreviewKonteringTable lines={data.preview_lines} />
      </div>
    )
  }

  // Legacy summary for operations staged before the preview carried full
  // lines: debit/credit accounts + gross amount + separate VAT rows.
  const legacyAmount = typeof data.amount === 'number' && Number.isFinite(data.amount)
    ? data.amount
    : null
  // On the review template a proposal staged without its kontering states
  // the date and the amount; the template marks the account as missing in a
  // row of its own, so two blank account rows would say the same thing twice.
  const noAccounts = !data.debit_account && !data.credit_account
  if (template && noAccounts) {
    return (
      <div className="text-sm">
        <FactRows groups={facts} />
        <FactList className={facts.some((group) => group.length > 0) ? 'border-t-0' : undefined}>
          <Fact label="Belopp" numeric>
            {legacyAmount === null ? '-' : formatCurrency(legacyAmount, (data.currency as string) || 'SEK')}
          </Fact>
        </FactList>
      </div>
    )
  }
  return (
    <div className="space-y-3 text-sm">
      <FactList>
        <Fact label="Debetkonto" mono>{String(data.debit_account ?? '')}</Fact>
        <Fact label="Kreditkonto" mono>{String(data.credit_account ?? '')}</Fact>
        {/* A preview with no usable amount used to render "NaN kr": show the
            gap as a gap instead of a number that isn't one. */}
        <Fact label="Belopp" mono>
          {legacyAmount === null ? '-' : formatCurrency(legacyAmount, (data.currency as string) || 'SEK')}
        </Fact>
      </FactList>
      {vatLines.length > 0 && (
        <div className={cn(!template && 'border-t pt-2')}>
          <p className="text-xs text-muted-foreground mb-1">Momsrader</p>
          <StagedLinesTable lines={vatLines} />
        </div>
      )}
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
          <span className="min-w-0 truncate mr-4">
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

function InvoicePreview({ data, selfBilled = false }: { data: Record<string, unknown>; selfBilled?: boolean }) {
  const template = useIsTemplate()
  const t = useTranslations('pending')
  const items = isPreviewInvoiceLines(data.items) ? data.items : []
  const [head = [], totals = []] = proposalFacts(selfBilled ? 'create_self_billed_invoice' : 'create_invoice', data) ?? []

  return (
    <div className="space-y-3 text-sm">
      <VatWarningLines data={data} />
      <FactRows groups={[head]} />
      {items.length > 0 && (
        <div className={cn(!template && 'border-t pt-2')}>
          <InvoiceLineRows items={items} currency={(data.currency as string) || 'SEK'} />
        </div>
      )}
      {selfBilled && typeof data.posts_on_approval === 'boolean' && (
        <p className="text-muted-foreground">
          {t(data.posts_on_approval ? 'preview_self_billed_posts' : 'preview_self_billed_cash')}
        </p>
      )}
      <div className={cn(!template && 'border-t pt-2')}>
        <FactRows groups={[totals]} totalsFrom={0} />
      </div>
    </div>
  )
}

// A registration's fields as staged: the text or date, '-' where it is absent.
const textOrDash = (value: unknown) => (typeof value === 'string' && value.trim() ? value : '-')
const dateOrDash = (value: unknown) => (typeof value === 'string' && value ? formatDate(value) : '-')
/** The verifikat a registration is tied to: its label and, when staged, its date. */
const registeredVoucherLine = (data: Record<string, unknown>) =>
  [textOrDash(data.voucher_label), typeof data.voucher_date === 'string' && data.voucher_date ? formatDate(data.voucher_date) : null]
    .filter(Boolean)
    .join(', ')

/**
 * A create_invoice staged by gnubok_register_booked_invoice (crm#1094):
 * nothing is posted and there are no draft lines, so what the approver checks
 * is which invoice it is, the verifikat it is tied to and what is left to pay.
 */
function RegisterBookedInvoicePreview({ data }: { data: Record<string, unknown> }) {
  const t = useTranslations('pending')
  const template = useIsTemplate()
  const currency = (data.currency as string) || 'SEK'
  const voucher = registeredVoucherLine(data)

  return (
    <div className="space-y-3 text-sm">
      <FactList>
        <Fact label={t('preview_field.customer_name')}>{textOrDash(data.customer_name)}</Fact>
        <Fact label={t('preview_field.invoice_number')} mono>{textOrDash(data.invoice_number)}</Fact>
        <Fact label={t('preview_field.invoice_date')} numeric>{dateOrDash(data.invoice_date)}</Fact>
        <Fact label={t('preview_field.due_date')} numeric>{dateOrDash(data.due_date)}</Fact>
        <Fact label={t('preview_field.voucher_label')} numeric>{voucher}</Fact>
        {typeof data.voucher_description === 'string' && data.voucher_description.trim() && (
          <Fact label={t('preview_field.voucher_description')}>{data.voucher_description}</Fact>
        )}
      </FactList>
      <FactList className={cn(!template && 'border-t pt-2')}>
        <Fact label={t('preview_field.vat_amount')} numeric alignEnd>{money(data.vat_amount, currency)}</Fact>
        <Fact label={t('preview_field.total')} numeric alignEnd>{money(data.total, currency)}</Fact>
        {/* A foreign invoice: the rate read from its verifikat, and the kronor that verifikat books. */}
        {typeof data.exchange_rate === 'number' && (
          <Fact label={t('preview_field.exchange_rate')} numeric alignEnd>
            {new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 6 }).format(data.exchange_rate)} ({money(data.total_sek, 'SEK')})
          </Fact>
        )}
        <Fact label={t('preview_field.invoice_remaining')} numeric alignEnd strong>{money(data.remaining_amount, currency)}</Fact>
        {typeof data.balance_as_of === 'string' && data.balance_as_of && (
          <Fact label={t('preview_field.balance_as_of')} numeric alignEnd>{formatDate(data.balance_as_of)}</Fact>
        )}
      </FactList>
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
  const template = useIsTemplate()
  const currency = (data.currency as string) || 'SEK'
  const voucher = registeredVoucherLine(data)
  const voucherLinesCaption = t('preview_registered_voucher_lines')

  return (
    <div className="space-y-3 text-sm">
      <FactList>
        <Fact label={t('preview_field.supplier_name')}>{textOrDash(data.supplier_name)}</Fact>
        <Fact label={t('preview_field.supplier_invoice_number')} mono>{textOrDash(data.supplier_invoice_number)}</Fact>
        {typeof data.payment_reference === 'string' && data.payment_reference.trim() && (
          <Fact label={t('preview_field.payment_reference')} mono>{data.payment_reference}</Fact>
        )}
        {typeof data.arrival_number === 'number' && (
          <Fact label={t('preview_field.arrival_number')} mono>{data.arrival_number}</Fact>
        )}
        <Fact label={t('preview_field.invoice_date')} numeric>{dateOrDash(data.invoice_date)}</Fact>
        <Fact label={t('preview_field.due_date')} numeric>{dateOrDash(data.due_date)}</Fact>
        <Fact label={t('preview_field.voucher_label')} numeric>{voucher}</Fact>
        {typeof data.voucher_description === 'string' && data.voucher_description.trim() && (
          <Fact label={t('preview_field.voucher_description')}>{data.voucher_description}</Fact>
        )}
      </FactList>
      {isKonteringLines(data.voucher_lines) && (
        <div className={cn('space-y-1', !template && 'border-t pt-2')}>
          <p className="text-xs text-muted-foreground">{voucherLinesCaption}</p>
          <PreviewKonteringTable lines={data.voucher_lines} label={voucherLinesCaption} />
        </div>
      )}
      <FactList className={cn(!template && 'border-t pt-2')}>
        <Fact label={t('preview_field.subtotal')} numeric alignEnd>{money(data.subtotal, currency)}</Fact>
        <Fact label={t('preview_field.vat_amount')} numeric alignEnd>{money(data.vat_amount, currency)}</Fact>
        <Fact label={t('preview_field.total')} numeric alignEnd>{money(data.total, currency)}</Fact>
        <Fact label={t('preview_field.invoice_remaining')} numeric alignEnd strong>{money(data.invoice_remaining, currency)}</Fact>
        {typeof data.balance_as_of === 'string' && data.balance_as_of && (
          <Fact label={t('preview_field.balance_as_of')} numeric alignEnd>{formatDate(data.balance_as_of)}</Fact>
        )}
      </FactList>
    </div>
  )
}

interface PreviewSupplierInvoiceLine {
  description?: string
  account_number?: string
  line_total?: number
}

/**
 * A supplier invoice read from the inbox, on the review template: the fields
 * a person checks against the file, the invoice rows with the account each
 * is booked on, and the sums. The other surfaces keep the generic preview.
 */
function SupplierInvoicePreview({ data }: { data: Record<string, unknown> }) {
  const t = useTranslations('pending')
  const tLines = useTranslations('voucher_lines')
  const accountNames = useContext(AccountNamesContext)
  const currency = (data.currency as string) || 'SEK'
  const [head = [], totals = []] = proposalFacts('create_supplier_invoice_from_inbox', data) ?? []
  const items = Array.isArray(data.items_preview) ? (data.items_preview as PreviewSupplierInvoiceLine[]) : []
  return (
    <div className="space-y-3 text-sm">
      <FactRows groups={[head]} />
      {items.length > 0 && (
        <table className="w-full border-collapse text-[13px]" aria-label={t('review_invoice_lines')}>
          <thead>
            <tr>
              <th className={VTH_CLASS}>{tLines('account')}</th>
              <th className={VTH_CLASS}>{tLines('description')}</th>
              <th className={cn(VTH_CLASS, 'pr-0 text-right')}>{t('preview_field.subtotal')}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item, index) => (
              <tr key={index}>
                <td className={VTD_CLASS}>
                  {item.account_number ? (
                    <>
                      <span className="font-mono text-sm">{item.account_number}</span>
                      {accountNames[item.account_number] && <span className="ml-1">{accountNames[item.account_number]}</span>}
                    </>
                  ) : (
                    '-'
                  )}
                </td>
                <td className={cn(VTD_CLASS, 'text-muted-foreground')} data-ph-mask="">{item.description ?? ''}</td>
                <td className={cn(VTD_CLASS, 'whitespace-nowrap pr-0 text-right tabular-nums')} data-ph-mask="">
                  {isLedgerCurrency(currency) && typeof item.line_total === 'number' ? formatAmount(item.line_total) : money(item.line_total, currency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <FactRows groups={[totals]} totalsFrom={0} />
    </div>
  )
}

/**
 * A bank row matched to a customer invoice, on the review template: the bank
 * row is the proposal's underlag, so the proposal states the invoice.
 */
function MatchInvoiceFacts({ data }: { data: Record<string, unknown> }) {
  const t = useTranslations('pending')
  const txDate = typeof data.transaction_date === 'string' ? data.transaction_date : null
  const invoiceDate = typeof data.invoice_date === 'string' ? data.invoice_date : null
  // The same nudge as the two-card preview: more than a month apart.
  const drift =
    txDate && invoiceDate && Math.abs(new Date(txDate).getTime() - new Date(invoiceDate).getTime()) > 31 * 24 * 60 * 60 * 1000
  return (
    <div className="space-y-2 text-sm">
      <FactRows groups={proposalFacts('match_transaction_invoice', data) ?? []} />
      {drift && <p className="text-xs text-muted-foreground">{t('preview_match_date_drift')}</p>}
    </div>
  )
}

/**
 * A document attached to a bank row, on the review template: the file and
 * the bank row are the underlag slot's, so the proposal names the two.
 */
function AttachDocumentFacts({ data }: { data: Record<string, unknown> }) {
  const t = useTranslations('pending')
  const amount = typeof data.transaction_amount === 'number' ? data.transaction_amount : null
  return (
    <FactList>
      <Fact label={t('preview_link_file')}>{textOrDash(data.document_file_name)}</Fact>
      <Fact label={t('review_bank_row')}>{textOrDash(data.transaction_description)}</Fact>
      {typeof data.transaction_date === 'string' && data.transaction_date && (
        <Fact label="Datum" numeric>{data.transaction_date}</Fact>
      )}
      {amount !== null && (
        <Fact label="Belopp" numeric>{formatCurrency(amount, (data.transaction_currency as string) || 'SEK')}</Fact>
      )}
    </FactList>
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
  const template = useIsTemplate()
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
      <FactList>
        <Fact label="Kund">{String(data.customer_name ?? '')}</Fact>
        <Fact label="Faktura">{data.invoice_number ? String(data.invoice_number) : 'utkast'}</Fact>
        {headerEntries.map(([key, value]) => (
          // null is an explicit clear (delivery_date: null), not a missing value
          <Fact key={key} label={UPDATE_INVOICE_FIELD_LABELS[key] ?? key.replace(/_/g, ' ')}>
            {value === null ? 'rensas' : renderValue(value)}
          </Fact>
        ))}
        {hasDimensionChange && (
          <Fact label="Dimensioner" mono>
            {dimensionBag && Object.keys(dimensionBag).length > 0
              ? Object.entries(dimensionBag).map(([dim, code]) => `${dim}: ${code}`).join(', ')
              : 'rensas'}
          </Fact>
        )}
      </FactList>
      {/* Full replace: show what goes away next to what comes in, so a
          quantity fix that also moves revenue off the article's account
          (3041 to 3001) or changes the VAT rate is visible before approval. */}
      {currentItems && (
        <div className={cn('space-y-1', !template && 'border-t pt-2')}>
          <div className="text-xs text-muted-foreground">
            {currentItems.length > 0 ? 'Nuvarande rader (ersätts)' : 'Nuvarande rader: inga'}
          </div>
          {currentItems.length > 0 && <InvoiceLineRows items={currentItems} currency={currency} />}
        </div>
      )}
      {newItems && (
        <div className={cn('space-y-1', !template && 'border-t pt-2')}>
          <div className="text-xs text-muted-foreground">Nya rader</div>
          <InvoiceLineRows items={newItems} currency={currency} />
        </div>
      )}
      {newItems && typeof data.total === 'number' && (
        <FactList className={cn(!template && 'border-t pt-2')}>
          <Fact label="Netto" numeric alignEnd>{money(data.subtotal, currency)}</Fact>
          <Fact label="Moms" numeric alignEnd>{money(data.vat_amount, currency)}</Fact>
          <Fact label="Totalt" numeric alignEnd strong>{money(data.total, currency)}</Fact>
        </FactList>
      )}
    </div>
  )
}

// Staged or posted lines through the shared VoucherLinesTable, named from
// this card's AccountNamesContext and never the active company's chart: the
// operation may be another company's. voucherLineViews reads every line shape
// the payloads use (account/debit/credit and account_number/debit_amount/
// credit_amount).

// The line-text column folded to nothing (not removed: the Summa row spans
// it, so its figures stay under Debet and Kredit).
const LEDGER_NARROW_CLASS =
  '@max-[460px]:[&_td:nth-child(2):nth-last-child(3)]:invisible @max-[460px]:[&_td:nth-child(2):nth-last-child(3)]:max-w-0 @max-[460px]:[&_td:nth-child(2):nth-last-child(3)]:overflow-hidden @max-[460px]:[&_td:nth-child(2):nth-last-child(3)]:whitespace-nowrap @max-[460px]:[&_td:nth-child(2):nth-last-child(3)]:px-0 @max-[460px]:[&_th:nth-child(2):nth-last-child(3)]:invisible @max-[460px]:[&_th:nth-child(2):nth-last-child(3)]:max-w-0 @max-[460px]:[&_th:nth-child(2):nth-last-child(3)]:overflow-hidden @max-[460px]:[&_th:nth-child(2):nth-last-child(3)]:whitespace-nowrap @max-[460px]:[&_th:nth-child(2):nth-last-child(3)]:px-0'

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
  // The review of one proposal reads the lines as a ledger: plain amounts
  // with the Summa row, so debit and credit are seen to balance. The confirm
  // surfaces state kronor.
  const template = useIsTemplate()
  const t = useTranslations('pending')
  const title = useContext(ReviewTitleContext)?.toLowerCase() ?? null
  const views = voucherLineViews(lines)
  // A line text the proposal's title already carries (the bank text of a
  // categorisation) is not repeated on every row.
  const repeated = title
    ? views.map((line) => line.description?.trim()).filter((text): text is string => !!text && title.includes(text.toLowerCase()))
    : []
  return (
    <VoucherLinesTable
      accountNames={accountNames}
      withCurrency={!template}
      showTotals={showTotals || (template && lines.length > 1)}
      aria-label={label ?? (template ? t('review_ledger_label') : undefined)}
      redundantTexts={repeated}
      // In a narrow column (a phone, the review beside its file) the line
      // text gives way: account, debit and credit are never cut or scrolled
      // out of view. The cell is the second of four; the Summa row has three.
      className={template ? LEDGER_NARROW_CLASS : undefined}
      lines={views}
    />
  )
}

// showSeries: false for a toEntryPreview payload, which carries no series;
// the engine picks it per source type at commit, so defaulting to A here
// would state a series the verifikat may not get. The missing-underlag
// warning (BFL 5 kap 6 §) is read by complianceWarningOf and rendered by
// OperationPreview above every preview type, not here.
function VoucherPreview({ data, showSeries = true }: { data: Record<string, unknown>; showSeries?: boolean }) {
  const tWarnings = useTranslations('voucherWarnings')
  const locale = useLocale()
  const lines = (data.lines as PostingLineLike[]) || []
  // The booking-time warnings the person confirmed when the voucher was staged.
  const confirmedWarnings = Array.isArray(data.voucher_warnings) ? (data.voucher_warnings as VoucherWarning[]) : []

  return (
    <div className="space-y-3 text-sm">
      {/* A lines-only payload (mark_invoice_paid's journal_entry_preview) has
          no date or text of its own: no empty rows for them. The
          momsdeklaration impact (crm#1447) is one of the fields. */}
      <FactRows groups={[voucherFacts(data, showSeries)]} />
      {/* The kontering with, when the payload carries them, its sums. */}
      {lines.length > 0 && <StagedLinesTable lines={lines} showTotals={data.total_debit != null && data.total_credit != null} />}
      {confirmedWarnings.length > 0 && (
        <div className="space-y-1">
          <div className="text-xs font-medium text-muted-foreground">{tWarnings('pending_heading')}</div>
          <ul className="space-y-1 text-xs text-muted-foreground">
            {confirmedWarnings.map((w) => (
              <li key={w.code}>{locale === 'en' ? w.message_en : w.message_sv}</li>
            ))}
          </ul>
        </div>
      )}
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
  const linkExisting = data.mode === 'link_existing'

  return (
    <div className="space-y-3 text-sm">
      <FactRows groups={proposalFacts('bulk_book_transactions', data) ?? []} />
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
        <p className="text-xs text-muted-foreground mb-1">
          Originalverifikation V{original.voucher ?? ''}, {original.entry_date ?? ''}
        </p>
        <p className="text-xs text-muted-foreground mb-2">{original.description ?? ''}</p>
        {original.lines && original.lines.length > 0 && <StagedLinesTable lines={original.lines} />}
      </div>
      <div>
        <p className="text-xs text-muted-foreground mb-1">
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
      <pre className="whitespace-pre-wrap break-words font-mono text-xs">
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

// Keys a staging tool adds about the change itself, beside the record it
// stages (update_supplier's payment_details_changed): stated even when the
// record's own fields are not.
const UPDATE_SUMMARY_KEYS = new Set(['payment_details_changed'])

// An update staged as the record it leaves: the agent's dry-run answer
// (company settings, the tax profile, the bookkeeping lock, a supplier), so
// every changed field is also a top-level key, beside every field the update
// leaves alone. Those unchanged fields are not what the approval does: the
// card listed a company's address, bank details and org number under a
// change of two invoice texts it did not show (crm#1605).
function isResultingRecord(data: Record<string, unknown>, changedFields: string[]): boolean {
  return changedFields.length > 0 && changedFields.every((field) => field in data)
}

// A changed value the card cannot state on one line (an email-text bag, the
// per-currency payment accounts): the change shows under its label as
// changed, without the structure.
function isStructuredValue(value: unknown): boolean {
  if (isPlainObject(value)) return Object.keys(value).length > 0
  return Array.isArray(value) && value.length > 0 && !value.every((v) => typeof v === 'string')
}

// A changed text longer than this (an invoice footer, a late-fee text) shows
// before and after on lines of their own, and outside the review panel is
// cut at COMPACT_TEXT.
const LONG_TEXT = 80
const COMPACT_TEXT = 160

function isLongText(value: unknown): value is string {
  return typeof value === 'string' && (value.length > LONG_TEXT || value.includes('\n'))
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
  const template = useIsTemplate()
  // A uuid is a database handle, not something the approver can check
  // against anything: the title already names the objects involved.
  // `will` is the staging tool's note to the agent, in English: on the
  // review template the bar states what the approval does, in the person's
  // language.
  const entries = Object.entries(data).filter(
    ([k, v]) => v != null && v !== '' && !GENERIC_PREVIEW_SKIPPED_KEYS.has(k) && !isUuid(v) && !(template && k === 'will'),
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
  const update = readUpdate(data)
  // An update staged as its resulting record states its changes, not the
  // record (crm#1605).
  const record = isResultingRecord(data, update.fields)
  const facts = labelled(Object.fromEntries(entries)).filter(([k]) => !record || UPDATE_SUMMARY_KEYS.has(k))
  // A labelled group shows its own labelled fields, one level down, instead
  // of a JSON dump of raw keys. An update's changes are the one group read
  // against what the record held, below.
  const groups = entries
    .filter(([k, v]) => !record && k !== 'changes' && isPlainObject(v) && !isEntryPreview(v) && t.has(`preview_field.${k}`))
    .map(([k, v]) => [k, v as Record<string, unknown>, labelled(v as Record<string, unknown>)] as const)
    .filter(([, , rows]) => rows.length > 0)
  // Each changed field with what it held, when the preview says, so the
  // approver judges the change without opening the record (crm#1300). A
  // field cleared shows as a change when its old value is known; a
  // structured one shows as changed.
  const changeFields = update.fields.filter((field) => {
    const after = update.after[field]
    const before = update.before[field]
    const cleared = after == null || after === ''
    return (
      t.has(`preview_field.${field}`) &&
      (stated(after) || (cleared && stated(before)) || isStructuredValue(after) || isStructuredValue(before))
    )
  })
  const fact = (key: string, value: string | number | boolean | string[], scope: Record<string, unknown>): ReactNode => {
    if (typeof value === 'boolean') return value ? t('preview_yes') : t('preview_no')
    if (typeof value === 'number') return formatPreviewNumber(key, value, scope)
    // A code (customer_type: eu_business) reads as its word where one exists.
    if (typeof value === 'string' && t.has(`preview_value.${key}.${value}`)) return t(`preview_value.${key}.${value}`)
    return Array.isArray(value) ? value.join(', ') : value
  }
  const factRow = (key: string, value: string | number | boolean | string[], scope: Record<string, unknown>, nested = false) => (
    <Fact key={key} label={t(`preview_field.${key}`)} mono={typeof value === 'number'} nested={nested}>
      {fact(key, value, scope)}
    </Fact>
  )
  // An empty or unreadable value (a dimension bag) shows as '-'. A long text
  // is cut outside the review panel, where the whole text is a click away.
  const changeValue = (field: string, value: unknown, scope: Record<string, unknown>): ReactNode => {
    if (!stated(value)) return '-'
    if (!detail && isLongText(value) && value.length > COMPACT_TEXT) return `${value.slice(0, COMPACT_TEXT).trimEnd()}…`
    return fact(field, value, scope)
  }
  const changeRow = (field: string) => {
    const before = update.before[field]
    const after = update.after[field]
    const known = field in update.before && (stated(before) || before == null || before === '')
    const beforeScope = { ...data, ...update.before }
    const afterScope = { ...data, ...update.after }
    const label = t(`preview_field.${field}`)
    if (isStructuredValue(after) || isStructuredValue(before)) {
      return (
        <Fact key={field} label={label} nested>
          {t('preview_change_structured')}
        </Fact>
      )
    }
    // A text too long for one line reads as the old text struck above the
    // new one, each kept as written (line breaks included).
    if (isLongText(before) || isLongText(after)) {
      return (
        <Fact key={field} label={label} nested>
          <span className="block space-y-1 text-left">
            {known && stated(before) && (
              <del className="block whitespace-pre-wrap text-muted-foreground">{changeValue(field, before, beforeScope)}</del>
            )}
            <ins className="block whitespace-pre-wrap no-underline">{changeValue(field, after, afterScope)}</ins>
          </span>
        </Fact>
      )
    }
    return (
      <Fact key={field} label={label} nested mono={typeof after === 'number' || typeof before === 'number'}>
        {known ? (
          <ValueChange before={changeValue(field, before, beforeScope)} after={changeValue(field, after, afterScope)} />
        ) : (
          changeValue(field, after, afterScope)
        )}
      </Fact>
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
            <p className="text-xs text-muted-foreground">
              {t('preview_entries_heading', { count: list.length })}
            </p>
            {shown.map((entry, i) => (
              <div key={i} className={cn(i > 0 && !template && 'border-t pt-3')}>
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
        <FactList compactClassName="grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          {facts.map(([key, value]) => factRow(key, value, data))}
          {groups.map(([key, obj, rows]) => (
            <Fragment key={key}>
              <FactGroupLabel>{t(`preview_field.${key}`)}</FactGroupLabel>
              {rows.map(([k, v]) => factRow(k, v, { ...data, ...obj }, true))}
            </Fragment>
          ))}
          {changeFields.length > 0 && (
            <>
              <FactGroupLabel>{t('preview_field.changes')}</FactGroupLabel>
              {changeFields.map(changeRow)}
            </>
          )}
        </FactList>
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
    <FactList>
      <Fact label={t('preview_account')}>
        <span className="font-mono tabular-nums">{String(data.account_number ?? '')}</span>
        {current.account_name ? ` ${String(current.account_name)}` : null}
      </Fact>
      {Object.entries(changes).map(([field, value]) => (
        <Fact key={field} label={label(field)}>
          <ValueChange before={show(field, current[field])} after={show(field, value)} />
        </Fact>
      ))}
    </FactList>
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

function LinkPreviewRows({ rows }: { rows: Array<{ label: string; value: ReactNode; tabular?: boolean }> }) {
  return (
    <FactList compactClassName="grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-3">
      {rows.map((row) => (
        <Fact key={row.label} label={row.label} numeric={row.tabular}>
          {row.value}
        </Fact>
      ))}
    </FactList>
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
  ownDocument,
}: {
  data: Record<string, unknown>
  params: Record<string, unknown>
  detail: boolean
  /** False where the surface shows the file itself, in its underlag slot. */
  ownDocument: boolean
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
    <PreviewBlock label={t('preview_link_voucher_heading')}>
      <LinkPreviewRows rows={voucherRows} />
      {detail && journalEntryId && (
        <div className="space-y-2 pt-1">
          {linesLoading ? (
            <LateReveal className="space-y-1.5">
              <Skeleton className="h-4 w-full rounded-sm" />
              <Skeleton className="h-4 w-full rounded-sm" />
            </LateReveal>
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
    </PreviewBlock>
  )

  const showViewer = detail && ownDocument && documentId != null
  const documentCard = (
    <PreviewBlock label={t('preview_link_document_heading')}>
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
        ) : ownDocument ? (
          <div className="pt-1">
            <DocumentViewButton documentId={documentId} />
          </div>
        ) : null)}
    </PreviewBlock>
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
        <ArrowDownIcon className="mr-1 h-3.5 w-3.5" aria-hidden />
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

/**
 * `template`: the review of one proposal (ProposalReview). The preview then
 * sets its fields as the template's hairline rows and leaves the warning and
 * the underlag to the template, which has a fixed place for each.
 */
export function OperationPreview({
  op,
  detail = false,
  template = false,
}: {
  op: OperationPreviewInput
  detail?: boolean
  template?: boolean
}) {
  const warningText = useComplianceWarningText()
  const warning = complianceWarningOf(op)
  const body = (() => {
    switch (op.operation_type) {
      case 'categorize_transaction':
        return <CategorizePreview data={op.preview_data} />
      // Typed fields only: review-model's customerFacts and transactionFacts.
      case 'create_customer':
      case 'create_transaction':
        return <FactRows groups={proposalFacts(op.operation_type, op.preview_data) ?? []} />
      case 'create_invoice':
        return isRegisterBookedInvoiceParams(op.preview_data)
          ? <RegisterBookedInvoicePreview data={op.preview_data} />
          : <InvoicePreview data={op.preview_data} />
      case 'create_self_billed_invoice':
        return <InvoicePreview data={op.preview_data} selfBilled />
      case 'create_supplier_invoice_from_inbox':
        return isRegisterBookedInvoiceParams(op.preview_data)
          ? <RegisterBookedSupplierInvoicePreview data={op.preview_data} />
          : template
            ? <SupplierInvoicePreview data={op.preview_data} />
            : <GenericPreview data={op.preview_data} />
      case 'update_invoice':
        return <UpdateInvoicePreview data={op.preview_data} />
      case 'create_voucher':
        return <VoucherPreview data={op.preview_data} />
      case 'bulk_book_transactions':
        return <BulkBookPreview data={op.preview_data} />
      case 'correct_entry':
        return <CorrectEntryPreview data={op.preview_data} />
      case 'update_account':
        return <UpdateAccountPreview data={op.preview_data} />
      case 'attach_document_to_transaction':
        // In the template the file and the bank row sit in the underlag
        // slot: the proposal states the pairing as typed fields.
        return template ? (
          <AttachDocumentFacts data={op.preview_data} />
        ) : (
          <AttachDocumentPreview data={op.preview_data} params={op.params ?? {}} detail={detail} />
        )
      case 'match_transaction_invoice':
        return template ? <MatchInvoiceFacts data={op.preview_data} /> : <MatchTransactionInvoicePreview data={op.preview_data} />
      case 'link_documents_to_vouchers':
        return <LinkDocumentsPreview data={op.preview_data} />
      case 'link_document_to_voucher':
        return (
          <LinkDocumentToVoucherPreview
            data={op.preview_data}
            params={op.params ?? {}}
            detail={detail}
            ownDocument={!template}
          />
        )
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
  if (template) return <PreviewDensityContext.Provider value="template">{body}</PreviewDensityContext.Provider>
  // One line above every preview type, from the same reading the Granskning
  // row uses. The VAT explanation stays inside the invoice previews, next to
  // the lines it is about.
  // The underlag closes every preview that does not render its own, in the
  // same place whatever the operation type.
  const docRef = proposalDocumentRef(op)
  const line = warning && warning.kind !== 'vat' ? warning : null
  if (!line && !docRef) return body
  return (
    <div className="space-y-3">
      {line && <AttnLine className="break-words">{warningText(line)}</AttnLine>}
      {body}
      {docRef && <ProposalDocument docRef={docRef} detail={detail} />}
    </div>
  )
}
