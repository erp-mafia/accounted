'use client'

// The one pending-op-owned preview (flows prereq, seam 8.3): renders what a
// staged pending_operation will do, dispatched on operation_type. Consumed by
// /pending (list detail + confirm dialogs), the chat ApprovalCard, and future
// flow-run views. Renderers moved verbatim from app/(dashboard)/pending/page.tsx;
// keep markup and classNames in lockstep with the design system, not with any
// one consumer.

import { Fragment, createContext, useContext } from 'react'
import { useTranslations } from 'next-intl'
import { cn, formatCurrency } from '@/lib/utils'
import { AttnLine } from '@/components/ui/attn-line'
import { VTH_CLASS, VTD_CLASS } from '@/components/ui/dry-table'
import type { PendingOperation } from '@/types'
import { AttachDocumentPreview } from '@/components/bookkeeping/AttachDocumentPreview'
import { MatchTransactionInvoicePreview } from '@/components/bookkeeping/MatchTransactionInvoicePreview'

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

type Translator = ReturnType<typeof useTranslations>

/** Render '-' instead of "NaN kr" when a preview payload omits an amount. */
function money(v: unknown, currency: string): string {
  return typeof v === 'number' && Number.isFinite(v) ? formatCurrency(v, currency) : '-'
}

function CategorizePreview({ data }: { data: Record<string, unknown> }) {
  const t = useTranslations('operation_preview')
  const accountNames = useContext(AccountNamesContext)
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
            <span className="text-muted-foreground">{t('date')}</span>
            <span className="font-mono tabular-nums">{data.date}</span>
          </div>
        )}
        <p className="text-xs text-muted-foreground mb-1">{t('voucher')}</p>
        {txCurrency !== 'SEK' && txAmount !== null && (
          <div className="flex justify-between gap-4 text-xs text-muted-foreground mb-1">
            <span>{t('bank_transaction')}</span>
            <span className="tabular-nums shrink-0">{formatCurrency(txAmount, txCurrency)}</span>
          </div>
        )}
        {lines.map((line, i) => {
          const debitAmt = typeof line.debit_amount === 'number' ? line.debit_amount : 0
          const creditAmt = typeof line.credit_amount === 'number' ? line.credit_amount : 0
          return (
            <div key={i} className="flex justify-between gap-4 font-mono text-xs">
              <span className="truncate">
                {line.account_number ?? '?'}{' '}
                {/* The account's own name first: it is what the posting means.
                    The line text follows only when it adds something the name
                    does not already say. */}
                <span className="text-foreground">
                  {(line.account_number && accountNames[line.account_number]) || line.description || ''}
                </span>
                {line.description &&
                line.account_number &&
                accountNames[line.account_number] &&
                line.description !== accountNames[line.account_number] ? (
                  <span className="text-muted-foreground"> · {line.description}</span>
                ) : null}
              </span>
              <span className="tabular-nums shrink-0">
                {debitAmt > 0 ? t('debit_short', { amount: formatCurrency(debitAmt) }) : t('credit_short', { amount: formatCurrency(creditAmt) })}
              </span>
            </div>
          )
        })}
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
        <p className="text-xs text-muted-foreground mb-1">{t('voucher')}</p>
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
        <span className="text-muted-foreground">{t('debit_account')}</span>
        <span className="font-mono">{String(data.debit_account ?? '')}</span>
        <span className="text-muted-foreground">{t('credit_account')}</span>
        <span className="font-mono">{String(data.credit_account ?? '')}</span>
        <span className="text-muted-foreground">{t('amount')}</span>
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
          <p className="text-xs text-muted-foreground mb-1">{t('vat_lines')}</p>
          {vatLines.map((line, i) => (
            <div key={i} className="flex justify-between font-mono text-xs">
              <span>
                {line.account_number}{' '}
                {accountNames[line.account_number] || line.description}
                {accountNames[line.account_number] &&
                line.description !== accountNames[line.account_number] ? (
                  <span className="text-muted-foreground"> · {line.description}</span>
                ) : null}
              </span>
              <span className="tabular-nums">
                {line.debit_amount > 0 ? t('debit_short', { amount: formatCurrency(line.debit_amount) }) : t('credit_short', { amount: formatCurrency(line.credit_amount) })}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function CustomerPreview({ data }: { data: Record<string, unknown> }) {
  const t = useTranslations('operation_preview')
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
      <span className="text-muted-foreground">{t('name')}</span>
      <span>{String(data.name ?? '')}</span>
      <span className="text-muted-foreground">{t('type')}</span>
      <span>{String(data.customer_type ?? '')}</span>
      {data.customer_number ? (
        <>
          <span className="text-muted-foreground">{t('customer_number')}</span>
          <span className="font-mono">{String(data.customer_number)}</span>
        </>
      ) : null}
      {data.email ? (
        <>
          <span className="text-muted-foreground">{t('email')}</span>
          <span>{String(data.email)}</span>
        </>
      ) : null}
      {data.org_number ? (
        <>
          <span className="text-muted-foreground">{t('org_number')}</span>
          <span className="font-mono">{String(data.org_number)}</span>
        </>
      ) : null}
      {data.personal_number_masked ? (
        <>
          <span className="text-muted-foreground">{t('personal_number')}</span>
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
  const t = useTranslations('operation_preview')
  return (
    <div className="space-y-1">
      {items.map((item, i) => (
        <div key={i} className="flex justify-between text-xs">
          <span className="truncate mr-4">
            {item.description}
            {item.line_type === 'text' ? null : ` (${item.quantity} ${item.unit})`}
            {typeof item.vat_rate === 'number' && item.line_type !== 'text' && (
              <span className="text-muted-foreground"> · {t('line_vat_rate', { rate: item.vat_rate })}</span>
            )}
            {item.revenue_account && (
              <span className="text-muted-foreground font-mono"> · {item.revenue_account}</span>
            )}
            {item.deduction_type && (
              <span className="text-muted-foreground"> · {item.deduction_type === 'rot' ? t('rot_deduction') : t('rut_deduction')}</span>
            )}
            {item.accrual_period_start && item.accrual_period_end && (
              <span className="text-muted-foreground"> · {t('line_accrual', { start: item.accrual_period_start, end: item.accrual_period_end })}</span>
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
  const t = useTranslations('operation_preview')
  const items = isPreviewInvoiceLines(data.items) ? data.items : []

  return (
    <div className="space-y-3 text-sm">
      <VatWarningLines data={data} />
      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        <span className="text-muted-foreground">{t('customer')}</span>
        <span>{String(data.customer_name ?? '')}</span>
        <span className="text-muted-foreground">{t('date')}</span>
        <span>{String(data.invoice_date ?? '')}</span>
        <span className="text-muted-foreground">{t('due_date')}</span>
        <span>{String(data.due_date ?? '')}</span>
      </div>
      {items.length > 0 && (
        <div className="border-t pt-2">
          <InvoiceLineRows items={items} currency={(data.currency as string) || 'SEK'} />
        </div>
      )}
      <div className="border-t pt-2 grid grid-cols-2 gap-x-4 gap-y-1">
        <span className="text-muted-foreground">{t('net')}</span>
        <span className="tabular-nums text-right">{money(data.subtotal, (data.currency as string) || 'SEK')}</span>
        <span className="text-muted-foreground">{t('vat')}</span>
        <span className="tabular-nums text-right">{money(data.vat_amount, (data.currency as string) || 'SEK')}</span>
        <span className="font-medium">{t('total')}</span>
        <span className="tabular-nums font-medium text-right">{money(data.total, (data.currency as string) || 'SEK')}</span>
      </div>
    </div>
  )
}

function updateInvoiceFieldLabel(key: string, t: Translator): string {
  switch (key) {
    case 'notes': return t('field_notes')
    case 'invoice_date': return t('field_invoice_date')
    case 'due_date': return t('due_date')
    case 'delivery_date': return t('field_delivery_date')
    case 'your_reference': return t('field_your_reference')
    case 'our_reference': return t('field_our_reference')
    default: return key.replace(/_/g, ' ')
  }
}

function UpdateInvoicePreview({ data }: { data: Record<string, unknown> }) {
  const t = useTranslations('operation_preview')
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
        <span className="text-muted-foreground">{t('customer')}</span>
        <span>{String(data.customer_name ?? '')}</span>
        <span className="text-muted-foreground">{t('invoice')}</span>
        <span>{data.invoice_number ? String(data.invoice_number) : t('draft')}</span>
        {headerEntries.map(([key, value]) => (
          <Fragment key={key}>
            <span className="text-muted-foreground">{updateInvoiceFieldLabel(key, t)}</span>
            {/* null is an explicit clear (delivery_date: null), not a missing value */}
            <span>{value === null ? t('cleared') : renderPrimitive(value, t)}</span>
          </Fragment>
        ))}
        {hasDimensionChange && (
          <>
            <span className="text-muted-foreground">{t('dimensions')}</span>
            <span className="font-mono text-xs">
              {dimensionBag && Object.keys(dimensionBag).length > 0
                ? Object.entries(dimensionBag).map(([dim, code]) => `${dim}: ${code}`).join(', ')
                : t('cleared')}
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
            {currentItems.length > 0 ? t('current_lines_replaced') : t('current_lines_none')}
          </div>
          {currentItems.length > 0 && <InvoiceLineRows items={currentItems} currency={currency} />}
        </div>
      )}
      {newItems && (
        <div className="border-t pt-2 space-y-1">
          <div className="text-xs text-muted-foreground">{t('new_lines')}</div>
          <InvoiceLineRows items={newItems} currency={currency} />
        </div>
      )}
      {newItems && typeof data.total === 'number' && (
        <div className="border-t pt-2 grid grid-cols-2 gap-x-4 gap-y-1">
          <span className="text-muted-foreground">{t('net')}</span>
          <span className="tabular-nums text-right">{money(data.subtotal, currency)}</span>
          <span className="text-muted-foreground">{t('vat')}</span>
          <span className="tabular-nums text-right">{money(data.vat_amount, currency)}</span>
          <span className="font-medium">{t('total')}</span>
          <span className="tabular-nums font-medium text-right">{money(data.total, currency)}</span>
        </div>
      )}
    </div>
  )
}

function CreateTransactionPreview({ data }: { data: Record<string, unknown> }) {
  const t = useTranslations('operation_preview')
  const currency = (data.currency as string) || 'SEK'

  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
      <span className="text-muted-foreground">{t('date')}</span>
      <span className="font-mono">{String(data.date ?? '')}</span>
      <span className="text-muted-foreground">{t('description')}</span>
      <span className="truncate">{String(data.description ?? '')}</span>
      <span className="text-muted-foreground">{t('amount')}</span>
      <span className="font-mono tabular-nums">
        {money(data.amount, currency)}
      </span>
      {data.external_id ? (
        <>
          <span className="text-muted-foreground">{t('external_reference')}</span>
          <span className="font-mono text-xs truncate">{String(data.external_id)}</span>
        </>
      ) : null}
    </div>
  )
}

type VoucherLine = {
  account_number: string
  account_name?: string | null
  debit_amount: number
  credit_amount: number
  line_description?: string | null
}

function VoucherLinesTable({ lines, currency }: { lines: VoucherLine[]; currency?: string }) {
  const accountNames = useContext(AccountNamesContext)
  return (
    <div className="border-t pt-2 space-y-1">
      {lines.map((line, i) => {
        // The account's own name first (staged account_name, else the chart
        // name); the line text only when it adds something.
        const name = line.account_name || accountNames[line.account_number] || ''
        const text = line.line_description || ''
        return (
        <div key={i} className="grid grid-cols-[auto_1fr_auto_auto] gap-x-3 text-xs items-baseline">
          <span className="font-mono text-muted-foreground">{line.account_number}</span>
          <span className="truncate">
            {name || text || '-'}
            {name && text && text !== name ? (
              <span className="text-muted-foreground"> · {text}</span>
            ) : null}
          </span>
          <span className="font-mono tabular-nums text-right w-24">
            {line.debit_amount > 0 ? formatCurrency(line.debit_amount, currency || 'SEK') : ''}
          </span>
          <span className="font-mono tabular-nums text-right w-24">
            {line.credit_amount > 0 ? formatCurrency(line.credit_amount, currency || 'SEK') : ''}
          </span>
        </div>
        )
      })}
    </div>
  )
}

function VoucherPreview({ data }: { data: Record<string, unknown> }) {
  const t = useTranslations('operation_preview')
  const lines = (data.lines as VoucherLine[]) || []
  const totalDebit = data.total_debit as number | undefined
  const totalCredit = data.total_credit as number | undefined
  // Advisory, mirrors the MCP staging warning: a verifikat for a received
  // handling must carry the handling itself (BFL 5 kap 6 §). Gated on the
  // staged compliance_warning, not on document_attached: the server decides
  // when the warning applies (IB entries are exempt there), so this stays a
  // mirror instead of a second, looser policy. Older ops without the field
  // render unchanged. The wording stays conditional ("om ... avser en
  // mottagen handling"): internal entries (accruals, FX) legitimately lack
  // a kvitto, and flagging them as deficient would be wrong.
  const missingUnderlag = typeof data.compliance_warning === 'string'

  return (
    <div className="space-y-3 text-sm">
      {missingUnderlag && (
        <AttnLine>
          {t('missing_document_warning')}
        </AttnLine>
      )}
      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        <span className="text-muted-foreground">{t('date')}</span>
        <span className="font-mono">{String(data.entry_date ?? '')}</span>
        <span className="text-muted-foreground">{t('description')}</span>
        <span className="truncate">{String(data.description ?? '')}</span>
        <span className="text-muted-foreground">{t('series')}</span>
        <span className="font-mono">{String(data.voucher_series ?? 'A')}</span>
      </div>
      {lines.length > 0 && (
        <div>
          <div className="grid grid-cols-[auto_1fr_auto_auto] gap-x-3 text-[11px] uppercase tracking-wider text-muted-foreground pb-1">
            <span>{t('col_account')}</span>
            <span>{t('col_text')}</span>
            <span className="text-right w-24">{t('col_debit')}</span>
            <span className="text-right w-24">{t('col_credit')}</span>
          </div>
          <VoucherLinesTable lines={lines} />
        </div>
      )}
      {totalDebit != null && totalCredit != null && (
        <div className="border-t pt-2 grid grid-cols-[auto_1fr_auto_auto] gap-x-3 text-xs">
          <span></span>
          <span className="text-muted-foreground">{t('sum')}</span>
          <span className="font-mono tabular-nums text-right w-24 font-medium">
            {formatCurrency(totalDebit)}
          </span>
          <span className="font-mono tabular-nums text-right w-24 font-medium">
            {formatCurrency(totalCredit)}
          </span>
        </div>
      )}
    </div>
  )
}

function BulkBookPreview({ data }: { data: Record<string, unknown> }) {
  const t = useTranslations('operation_preview')
  // Samlingsverifikat over N bank rows. The staged kontering IS what the RPC
  // posts on approval, so it is the load-bearing part of this card; the
  // aggregates alone ("-720, 2 tx, expense") cannot tell a right booking from
  // a wrong one. Journal lines are SEK; the bank sum is shown in the rows'
  // own currency so a foreign batch is never misread as SEK.
  const lines = (data.lines as VoucherLine[]) || []
  const txCount = typeof data.tx_count === 'number' ? data.tx_count : null
  const txSum = typeof data.tx_sum === 'number' && Number.isFinite(data.tx_sum) ? data.tx_sum : null
  const currency = (data.currency as string) || 'SEK'
  const linkExisting = data.mode === 'link_existing'
  const totalDebit = lines.reduce((s, l) => s + (l.debit_amount > 0 ? l.debit_amount : 0), 0)
  const totalCredit = lines.reduce((s, l) => s + (l.credit_amount > 0 ? l.credit_amount : 0), 0)

  return (
    <div className="space-y-3 text-sm">
      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        <span className="text-muted-foreground">{t('date')}</span>
        <span className="font-mono">{String(data.tx_date ?? '')}</span>
        <span className="text-muted-foreground">{t('transactions')}</span>
        <span className="font-mono tabular-nums">
          {txCount ?? '-'}
          {txSum !== null ? ` · ${formatCurrency(txSum, currency)}` : ''}
        </span>
        <span className="text-muted-foreground">{t('action')}</span>
        <span>{linkExisting ? t('action_link_existing') : t('action_new_collective')}</span>
        {data.entry_description ? (
          <>
            <span className="text-muted-foreground">{t('description')}</span>
            <span className="truncate">{String(data.entry_description)}</span>
          </>
        ) : null}
      </div>
      {lines.length > 0 && (
        <div>
          <div className="grid grid-cols-[auto_1fr_auto_auto] gap-x-3 text-[11px] uppercase tracking-wider text-muted-foreground pb-1">
            <span>{t('col_account')}</span>
            <span>{t('col_text')}</span>
            <span className="text-right w-24">{t('col_debit')}</span>
            <span className="text-right w-24">{t('col_credit')}</span>
          </div>
          <VoucherLinesTable lines={lines} />
          <div className="border-t pt-2 grid grid-cols-[auto_1fr_auto_auto] gap-x-3 text-xs">
            <span></span>
            <span className="text-muted-foreground">{t('sum')}</span>
            <span className="font-mono tabular-nums text-right w-24 font-medium">
              {formatCurrency(totalDebit)}
            </span>
            <span className="font-mono tabular-nums text-right w-24 font-medium">
              {formatCurrency(totalCredit)}
            </span>
          </div>
        </div>
      )}
      {linkExisting && lines.length === 0 && (
        <p className="text-xs text-muted-foreground">
          {t('link_existing_note')}
        </p>
      )}
    </div>
  )
}

function CorrectEntryPreview({ data }: { data: Record<string, unknown> }) {
  const t = useTranslations('operation_preview')
  const original = (data.original as {
    voucher?: string
    entry_date?: string
    description?: string
    lines?: VoucherLine[]
  }) || {}
  const correction = (data.correction as {
    total_debit?: number
    total_credit?: number
    line_count?: number
    lines?: VoucherLine[]
  }) || {}

  return (
    <div className="space-y-4 text-sm">
      <div>
        <p className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1">
          {t('original_voucher', { voucher: original.voucher ?? '', date: original.entry_date ?? '' })}
        </p>
        <p className="text-xs text-muted-foreground italic mb-2">{original.description ?? ''}</p>
        {original.lines && original.lines.length > 0 && (
          <VoucherLinesTable lines={original.lines} />
        )}
      </div>
      <div>
        <p className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1">
          {t('corrected_voucher', { count: correction.line_count ?? correction.lines?.length ?? 0 })}
        </p>
        {correction.lines && correction.lines.length > 0 && (
          <VoucherLinesTable lines={correction.lines} />
        )}
        {correction.total_debit != null && (
          <div className="border-t pt-1 grid grid-cols-[auto_1fr_auto_auto] gap-x-3 text-xs mt-1">
            <span></span>
            <span className="text-muted-foreground">{t('sum')}</span>
            <span className="font-mono tabular-nums text-right w-24 font-medium">
              {formatCurrency(correction.total_debit)}
            </span>
            <span className="font-mono tabular-nums text-right w-24 font-medium">
              {formatCurrency(correction.total_credit ?? 0)}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

// Render a primitive (string/number/bool) or a short summary of an array/object.
// Used by GenericPreview to avoid the "[object Object]" stringification that
// occurs when an operation_type has no dedicated preview component.
function renderPrimitive(value: unknown, t: Translator): string {
  if (value == null) return ''
  if (Array.isArray(value)) return t('rows_count', { count: value.length })
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

// A preview_data value that is a kontering (array of account/debit/credit
// rows). Several staged op types carry one under keys like `preview_lines`
// without a dedicated preview component; rendering it as the actual
// verifikat rows is what makes the detail panel say what the agent will do.
interface PreviewKonteringLine {
  account?: string
  account_number?: string
  description?: string
  debit?: number
  credit?: number
  debit_amount?: number
  credit_amount?: number
}

function isKonteringLines(value: unknown): value is PreviewKonteringLine[] {
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

function PreviewKonteringTable({ lines }: { lines: PreviewKonteringLine[] }) {
  const t = useTranslations('operation_preview')
  const accountNames = useContext(AccountNamesContext)
  const amount = (n: number | undefined) =>
    n && n > 0 ? n.toLocaleString('sv-SE', { minimumFractionDigits: 2 }) : ''
  return (
    <table className="w-full border-collapse text-[12.5px]" aria-label={t('proposed_posting')}>
      <thead>
        <tr>
          <th className={cn(VTH_CLASS, 'w-[70px]')}>{t('col_account')}</th>
          <th className={VTH_CLASS}>{t('description')}</th>
          <th className={cn(VTH_CLASS, 'text-right')}>{t('col_debit')}</th>
          <th className={cn(VTH_CLASS, 'text-right')}>{t('col_credit')}</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((line, i) => (
          <tr key={i}>
            <td className={cn(VTD_CLASS, 'whitespace-nowrap font-mono tabular-nums')}>
              {line.account ?? line.account_number}
            </td>
            <td className={cn(VTD_CLASS, 'text-muted-foreground')}>
              {line.description || accountNames[String(line.account ?? line.account_number ?? '')] || ''}
            </td>
            <td className={cn(VTD_CLASS, 'whitespace-nowrap text-right tabular-nums')}>
              {amount(line.debit ?? line.debit_amount)}
            </td>
            <td className={cn(VTD_CLASS, 'whitespace-nowrap text-right tabular-nums')}>
              {amount(line.credit ?? line.credit_amount)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function GenericPreview({ data }: { data: Record<string, unknown> }) {
  const t = useTranslations('operation_preview')
  // Skip period_status here: it's surfaced in the dedicated banner, not the
  // generic key-value dump (otherwise the approver sees the same fact twice).
  const entries = Object.entries(data).filter(([k, v]) => v != null && v !== '' && k !== 'period_status')
  const konteringEntries = entries.filter(([, v]) => isKonteringLines(v))
  const rest = entries.filter(([, v]) => !isKonteringLines(v))
  return (
    <div className="space-y-3">
      {konteringEntries.map(([key, value]) => (
        <PreviewKonteringTable key={key} lines={value as PreviewKonteringLine[]} />
      ))}
      {rest.length > 0 && (
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          {rest.map(([key, value]) => (
            <Fragment key={key}>
              <span className="text-muted-foreground">{key.replace(/_/g, ' ')}</span>
              <span className={typeof value === 'number' ? 'font-mono tabular-nums' : ''}>
                {renderPrimitive(value, t)}
              </span>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  )
}

export function OperationPreview({ op }: { op: OperationPreviewInput }) {
  const body = (() => {
    switch (op.operation_type) {
      case 'categorize_transaction':
        return <CategorizePreview data={op.preview_data} />
      case 'create_customer':
        return <CustomerPreview data={op.preview_data} />
      case 'create_invoice':
        return <InvoicePreview data={op.preview_data} />
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
      case 'attach_document_to_transaction':
        return <AttachDocumentPreview data={op.preview_data} params={op.params ?? {}} />
      case 'match_transaction_invoice':
        return <MatchTransactionInvoicePreview data={op.preview_data} />
      default:
        return <GenericPreview data={op.preview_data} />
    }
  })()
  return body
}
