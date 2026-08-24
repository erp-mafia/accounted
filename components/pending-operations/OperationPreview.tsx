'use client'

// The one pending-op-owned preview (flows prereq, seam 8.3): renders what a
// staged pending_operation will do, dispatched on operation_type. Consumed by
// /pending (list detail + confirm dialogs), the chat ApprovalCard, and future
// flow-run views. Renderers moved verbatim from app/(dashboard)/pending/page.tsx;
// keep markup and classNames in lockstep with the design system, not with any
// one consumer.

import { Fragment, createContext, useContext } from 'react'
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

/** Render '-' instead of "NaN kr" when a preview payload omits an amount. */
function money(v: unknown, currency: string): string {
  return typeof v === 'number' && Number.isFinite(v) ? formatCurrency(v, currency) : '-'
}

function CategorizePreview({ data }: { data: Record<string, unknown> }) {
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
                {debitAmt > 0 ? `D ${formatCurrency(debitAmt)}` : `K ${formatCurrency(creditAmt)}`}
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
                {line.debit_amount > 0 ? `D ${formatCurrency(line.debit_amount)}` : `K ${formatCurrency(line.credit_amount)}`}
              </span>
            </div>
          ))}
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

function InvoicePreview({ data }: { data: Record<string, unknown> }) {
  const items = (data.items as Array<{ description: string; quantity: number; unit: string; unit_price: number; line_total: number; vat_rate: number }>) || []

  return (
    <div className="space-y-3 text-sm">
      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        <span className="text-muted-foreground">Kund</span>
        <span>{String(data.customer_name ?? '')}</span>
        <span className="text-muted-foreground">Datum</span>
        <span>{String(data.invoice_date ?? '')}</span>
        <span className="text-muted-foreground">Förfallodatum</span>
        <span>{String(data.due_date ?? '')}</span>
      </div>
      {items.length > 0 && (
        <div className="border-t pt-2 space-y-1">
          {items.map((item, i) => (
            <div key={i} className="flex justify-between text-xs">
              <span className="truncate mr-4">{item.description} ({item.quantity} {item.unit})</span>
              <span className="font-mono tabular-nums whitespace-nowrap">
                {formatCurrency(item.line_total, (data.currency as string) || 'SEK')}
              </span>
            </div>
          ))}
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
  const lines = (data.lines as VoucherLine[]) || []
  const totalDebit = data.total_debit as number | undefined
  const totalCredit = data.total_credit as number | undefined
  // Advisory, mirrors the MCP staging warning: a verifikat for a received
  // handling must carry the handling itself (BFL 5 kap 6 §). Only shown when
  // the staging explicitly said no document is attached; older ops without
  // the flag render unchanged. The wording is conditional ("om ... avser en
  // mottagen handling"): IB and internal entries (accruals, FX) legitimately
  // lack a kvitto, and flagging them as deficient would be wrong.
  const missingUnderlag = data.document_attached === false

  return (
    <div className="space-y-3 text-sm">
      {missingUnderlag && (
        <AttnLine>
          Underlag saknas: om verifikatet avser en mottagen handling ska handlingen användas som
          verifikation (BFL 5 kap 6 §).
        </AttnLine>
      )}
      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        <span className="text-muted-foreground">Datum</span>
        <span className="font-mono">{String(data.entry_date ?? '')}</span>
        <span className="text-muted-foreground">Beskrivning</span>
        <span className="truncate">{String(data.description ?? '')}</span>
        <span className="text-muted-foreground">Serie</span>
        <span className="font-mono">{String(data.voucher_series ?? 'A')}</span>
      </div>
      {lines.length > 0 && (
        <div>
          <div className="grid grid-cols-[auto_1fr_auto_auto] gap-x-3 text-[11px] uppercase tracking-wider text-muted-foreground pb-1">
            <span>Konto</span>
            <span>Text</span>
            <span className="text-right w-24">Debet</span>
            <span className="text-right w-24">Kredit</span>
          </div>
          <VoucherLinesTable lines={lines} />
        </div>
      )}
      {totalDebit != null && totalCredit != null && (
        <div className="border-t pt-2 grid grid-cols-[auto_1fr_auto_auto] gap-x-3 text-xs">
          <span></span>
          <span className="text-muted-foreground">Summa</span>
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
        <span className="text-muted-foreground">Datum</span>
        <span className="font-mono">{String(data.tx_date ?? '')}</span>
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
      {lines.length > 0 && (
        <div>
          <div className="grid grid-cols-[auto_1fr_auto_auto] gap-x-3 text-[11px] uppercase tracking-wider text-muted-foreground pb-1">
            <span>Konto</span>
            <span>Text</span>
            <span className="text-right w-24">Debet</span>
            <span className="text-right w-24">Kredit</span>
          </div>
          <VoucherLinesTable lines={lines} />
          <div className="border-t pt-2 grid grid-cols-[auto_1fr_auto_auto] gap-x-3 text-xs">
            <span></span>
            <span className="text-muted-foreground">Summa</span>
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
          Originalverifikation V{original.voucher ?? ''}, {original.entry_date ?? ''}
        </p>
        <p className="text-xs text-muted-foreground italic mb-2">{original.description ?? ''}</p>
        {original.lines && original.lines.length > 0 && (
          <VoucherLinesTable lines={original.lines} />
        )}
      </div>
      <div>
        <p className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1">
          Korrigerad verifikation ({correction.line_count ?? correction.lines?.length ?? 0} rader)
        </p>
        {correction.lines && correction.lines.length > 0 && (
          <VoucherLinesTable lines={correction.lines} />
        )}
        {correction.total_debit != null && (
          <div className="border-t pt-1 grid grid-cols-[auto_1fr_auto_auto] gap-x-3 text-xs mt-1">
            <span></span>
            <span className="text-muted-foreground">Summa</span>
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
function renderPrimitive(value: unknown): string {
  if (value == null) return ''
  if (Array.isArray(value)) return `${value.length} rader`
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
  const accountNames = useContext(AccountNamesContext)
  const amount = (n: number | undefined) =>
    n && n > 0 ? n.toLocaleString('sv-SE', { minimumFractionDigits: 2 }) : ''
  return (
    <table className="w-full border-collapse text-[12.5px]" aria-label="Föreslagen kontering">
      <thead>
        <tr>
          <th className={cn(VTH_CLASS, 'w-[70px]')}>Konto</th>
          <th className={VTH_CLASS}>Beskrivning</th>
          <th className={cn(VTH_CLASS, 'text-right')}>Debet</th>
          <th className={cn(VTH_CLASS, 'text-right')}>Kredit</th>
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
                {renderPrimitive(value)}
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
