'use client'

import { Fragment } from 'react'
import { useTranslations } from 'next-intl'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { VTH_CLASS, VTD_CLASS } from '@/components/ui/dry-table'

/**
 * reconciliation_match: outside rows (Skatteverket events or bank
 * transactions) linked to verifikat that already exist. What the approver
 * approves is "these rows belong to this verifikat", so that is the card: per
 * pair the rows with date, text and amount, their sum, the verifikat, and
 * what the verifikat holds on the reconciled account. The generic preview
 * showed a pair count and a source, which left nothing to check (crm#1147).
 *
 * Reads `pair_details` (staged by gnubok_reconcile_match through
 * describeMatchPairs, lib/reconciliation/pair-preview.ts) and the dry run's
 * `settled` list (verifikat linked against each other, no outside row). An
 * operation staged before the details existed has neither: OperationPreview
 * asks hasReconciliationMatchDetails first and keeps the generic preview.
 */

interface PairRow {
  external_id?: string
  date: string
  text: string
  amount: number
  currency?: string
}

interface PairEntry {
  journal_entry_id?: string
  voucher_series?: string | null
  voucher_number?: number | null
  entry_date: string
  description: string
  account_debit: number
  account_credit: number
  allocated_amount?: number
}

interface PairDetail {
  rows: PairRow[]
  row_count: number
  rows_total: number | null
  rows_currency?: string
  entries: PairEntry[]
  already_linked_count?: number
  already_linked_total?: number
  remainder_amount?: number
}

interface SettledEntry {
  journal_entry_id?: string
  voucher_series?: string | null
  voucher_number?: number | null
  entry_date: string
  amount: number
}

interface Settlement {
  account_number?: string
  entries: SettledEntry[]
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isAmount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function isPairRow(v: unknown): v is PairRow {
  return isObject(v) && typeof v.date === 'string' && typeof v.text === 'string' && isAmount(v.amount)
}

function isPairEntry(v: unknown): v is PairEntry {
  return (
    isObject(v) &&
    typeof v.entry_date === 'string' &&
    typeof v.description === 'string' &&
    isAmount(v.account_debit) &&
    isAmount(v.account_credit)
  )
}

function isPairDetail(v: unknown): v is PairDetail {
  return (
    isObject(v) &&
    Array.isArray(v.rows) &&
    v.rows.length > 0 &&
    v.rows.every(isPairRow) &&
    Array.isArray(v.entries) &&
    v.entries.length > 0 &&
    v.entries.every(isPairEntry) &&
    isAmount(v.row_count) &&
    (v.rows_total === null || isAmount(v.rows_total))
  )
}

function isSettlement(v: unknown): v is Settlement {
  return (
    isObject(v) &&
    Array.isArray(v.entries) &&
    v.entries.length > 0 &&
    v.entries.every((e) => isObject(e) && typeof e.entry_date === 'string' && isAmount(e.amount))
  )
}

/** The pairs and settlements this preview can render; anything malformed is left out. */
function readDetails(data: Record<string, unknown>): { pairs: PairDetail[]; settlements: Settlement[] } {
  return {
    pairs: Array.isArray(data.pair_details) ? data.pair_details.filter(isPairDetail) : [],
    settlements: Array.isArray(data.settled) ? data.settled.filter(isSettlement) : [],
  }
}

/**
 * True when the staged preview carries something this card can show. False
 * for an operation staged before pair_details existed (or whose details could
 * not be read at staging): the caller renders the generic preview instead.
 */
export function hasReconciliationMatchDetails(data: Record<string, unknown>): boolean {
  const { pairs, settlements } = readDetails(data)
  return pairs.length + settlements.length > 0
}

// Outside the Granskning panel (the chat card, the confirm dialog) a long
// operation stops after a few pairs and rows; the panel shows all it has.
const PAIRS_COMPACT = 3
const ROWS_COMPACT = 5

const sek = (amount: number) => formatCurrency(amount, 'SEK')

export function ReconciliationMatchPreview({
  data,
  detail = false,
}: {
  data: Record<string, unknown>
  detail?: boolean
}) {
  const t = useTranslations('pending')
  const { pairs, settlements } = readDetails(data)
  const ledgerAccount = typeof data.ledger_account === 'string' ? data.ledger_account : null
  const stagedPairs = isAmount(data.pair_count) ? data.pair_count : pairs.length + settlements.length
  const shownPairs = detail ? pairs : pairs.slice(0, PAIRS_COMPACT)
  // Every staged pair the card does not list: cut for the compact card, past
  // the cap at staging, or unreadable.
  const hiddenPairs = Math.max(0, stagedPairs - shownPairs.length - settlements.length)

  const onAccount = (debit: number, credit: number) => {
    const sides = [
      debit !== 0 ? t('recon_preview_debit', { amount: sek(debit) }) : null,
      credit !== 0 ? t('recon_preview_credit', { amount: sek(credit) }) : null,
    ].filter((side): side is string => side !== null)
    return sides.length > 0 ? sides.join(', ') : '-'
  }

  return (
    <div className="space-y-3 text-sm">
      {shownPairs.length > 0 && (
        <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
          {t('recon_preview_heading', { count: stagedPairs })}
        </p>
      )}
      {shownPairs.map((pair, i) => {
        const rows = detail ? pair.rows : pair.rows.slice(0, ROWS_COMPACT)
        const hiddenRows = Math.max(0, pair.row_count - rows.length)
        const remainder = pair.remainder_amount
        return (
          <div key={i} className={cn('space-y-2', i > 0 && 'border-t pt-3')}>
            {/* data-ph-mask: event texts and amounts are user data */}
            <table className="w-full border-collapse text-[12.5px]" aria-label={t('recon_preview_rows_label')} data-ph-mask="">
              <thead>
                <tr>
                  <th className={VTH_CLASS}>{t('recon_preview_date')}</th>
                  <th className={VTH_CLASS}>{t('recon_preview_text')}</th>
                  <th className={cn(VTH_CLASS, 'pr-0 text-right')}>{t('recon_preview_amount')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, j) => (
                  <tr key={row.external_id ?? j}>
                    <td className={cn(VTD_CLASS, 'whitespace-nowrap tabular-nums text-muted-foreground')}>
                      {formatDate(row.date)}
                    </td>
                    <td className={cn(VTD_CLASS, 'min-w-0 break-words')}>{row.text || '-'}</td>
                    <td className={cn(VTD_CLASS, 'whitespace-nowrap pr-0 text-right tabular-nums')}>
                      {formatCurrency(row.amount, row.currency ?? 'SEK')}
                    </td>
                  </tr>
                ))}
                {hiddenRows > 0 && (
                  <tr>
                    <td colSpan={3} className={cn(VTD_CLASS, 'pr-0 text-muted-foreground')}>
                      {t('recon_preview_rows_more', { count: hiddenRows })}
                    </td>
                  </tr>
                )}
                <tr>
                  <td colSpan={2} className={cn(VTD_CLASS, 'text-muted-foreground')}>
                    {t('recon_preview_sum', { count: pair.row_count })}
                  </td>
                  <td className={cn(VTD_CLASS, 'whitespace-nowrap pr-0 text-right font-medium tabular-nums')}>
                    {pair.rows_total === null ? '-' : formatCurrency(pair.rows_total, pair.rows_currency ?? 'SEK')}
                  </td>
                </tr>
              </tbody>
            </table>
            {pair.entries.map((entry, j) => (
              <div
                key={entry.journal_entry_id ?? j}
                className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-3 gap-y-1"
              >
                <span className="text-xs text-muted-foreground">{t('recon_preview_voucher')}</span>
                <span className="min-w-0 break-words tabular-nums">
                  <span className="font-mono">{formatVoucher(entry)}</span>
                  <span className="text-muted-foreground"> · {formatDate(entry.entry_date)}</span>
                </span>
                {entry.description && (
                  <Fragment>
                    <span className="text-xs text-muted-foreground">{t('recon_preview_description')}</span>
                    <span className="min-w-0 break-words" data-ph-mask="">
                      {entry.description}
                    </span>
                  </Fragment>
                )}
                <span className="text-xs text-muted-foreground">
                  {ledgerAccount
                    ? t('recon_preview_on_account', { account: ledgerAccount })
                    : t('recon_preview_on_the_account')}
                </span>
                <span className="min-w-0 break-words tabular-nums">
                  {onAccount(entry.account_debit, entry.account_credit)}
                </span>
                {isAmount(entry.allocated_amount) && (
                  <Fragment>
                    <span className="text-xs text-muted-foreground">{t('recon_preview_allocated')}</span>
                    <span className="min-w-0 break-words tabular-nums">
                      {formatCurrency(entry.allocated_amount, pair.rows_currency ?? 'SEK')}
                    </span>
                  </Fragment>
                )}
                {isAmount(pair.already_linked_total) && isAmount(pair.already_linked_count) && (
                  <Fragment>
                    <span className="text-xs text-muted-foreground">{t('recon_preview_already_linked')}</span>
                    <span className="min-w-0 break-words tabular-nums">
                      {t('recon_preview_already_linked_value', {
                        amount: sek(pair.already_linked_total),
                        count: pair.already_linked_count,
                      })}
                    </span>
                  </Fragment>
                )}
              </div>
            ))}
            {isAmount(remainder) &&
              (remainder === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {isAmount(pair.already_linked_count) && pair.already_linked_count > 0
                    ? t('recon_preview_explained_with_linked')
                    : t('recon_preview_explained')}
                </p>
              ) : (
                <p className="text-xs text-attn">{t('recon_preview_remainder', { amount: sek(remainder) })}</p>
              ))}
          </div>
        )
      })}
      {settlements.map((settlement, i) => (
        <div key={`settled-${i}`} className={cn('space-y-2', (i > 0 || shownPairs.length > 0) && 'border-t pt-3')}>
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
            {settlement.account_number
              ? t('recon_preview_settled_heading_account', { account: settlement.account_number })
              : t('recon_preview_settled_heading')}
          </p>
          <table className="w-full border-collapse text-[12.5px]" aria-label={t('recon_preview_settled_heading')}>
            <thead>
              <tr>
                <th className={VTH_CLASS}>{t('recon_preview_voucher')}</th>
                <th className={VTH_CLASS}>{t('recon_preview_date')}</th>
                <th className={cn(VTH_CLASS, 'pr-0 text-right')}>{t('recon_preview_amount')}</th>
              </tr>
            </thead>
            <tbody>
              {settlement.entries.map((entry, j) => (
                <tr key={entry.journal_entry_id ?? j}>
                  <td className={cn(VTD_CLASS, 'whitespace-nowrap font-mono tabular-nums')}>{formatVoucher(entry)}</td>
                  <td className={cn(VTD_CLASS, 'whitespace-nowrap tabular-nums text-muted-foreground')}>
                    {formatDate(entry.entry_date)}
                  </td>
                  <td className={cn(VTD_CLASS, 'whitespace-nowrap pr-0 text-right tabular-nums')}>{sek(entry.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      {hiddenPairs > 0 && (
        <p className="text-xs text-muted-foreground">{t('recon_preview_pairs_more', { count: hiddenPairs })}</p>
      )}
    </div>
  )
}
