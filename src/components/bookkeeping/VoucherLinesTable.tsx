'use client'

import type { ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { AccountNumber } from '@/components/ui/account-number'
import { VTD_CLASS, VTH_CLASS } from '@/components/ui/dry-table'
import { getAccountDescription } from '@/lib/bookkeeping/account-descriptions'
import { roundOre } from '@/lib/money'
import { cn, formatAmount, formatCurrency } from '@/lib/utils'

export interface VoucherTableLine {
  /** Row key; the index when absent. */
  key?: string | number
  account_number: string
  /** The account's name when the caller knows it (a staged account not yet in the chart); else the chart's or BAS's. */
  account_name?: string | null
  /** The line's own text. Hidden when it only repeats the account name or one of `redundantTexts`. */
  description?: string | null
  debit_amount: number | string | null | undefined
  credit_amount: number | string | null | undefined
  /** The original amount of a foreign-currency line, e.g. "100,00 EUR", shown under the SEK amount. */
  foreignAmount?: string | null
  /** Struck by an inline rättelse: shown crossed out and muted. */
  struck?: boolean
  /** Content after the text: a marker chip, a dimension tag, a row action. */
  extra?: ReactNode
}

interface VoucherLinesTableProps {
  lines: readonly VoucherTableLine[]
  /** A Summa row under the lines (struck rows are left out of it). */
  showTotals?: boolean
  /** Texts a line description adds nothing to besides the account name, e.g. the verifikat's own description. */
  redundantTexts?: ReadonlyArray<string | null | undefined>
  /** Render at most this many rows, then a "+ N more rows" row. */
  maxRows?: number
  /**
   * Account names from the caller, used instead of the active company's
   * chart: an approval card may show another company's operation, where the
   * active chart's custom names would be the wrong ones. A number the map
   * lacks shows bare.
   */
  accountNames?: Readonly<Record<string, string>>
  /** Amounts as kronor ("1 250 kr"), as confirm surfaces state them; the ledger form ("1 250,00") otherwise. */
  withCurrency?: boolean
  /**
   * Swedish heads in both locales, for the surfaces that stay Swedish
   * (.claude/rules/i18n.md: the year-end wizard, the verifikat page).
   */
  swedish?: boolean
  'aria-label'?: string
  className?: string
}

const SWEDISH_HEADS = { account: 'Konto', description: 'Beskrivning', debit: 'Debet', credit: 'Kredit', total: 'Summa' } as const

const amountOf = (value: number | string | null | undefined): number => Number(value) || 0

/** The Summa row's figures: every line that is not struck, rounded to the öre. */
export function voucherLinesTotals(lines: readonly VoucherTableLine[]): { debit: number; credit: number } {
  const live = lines.filter((l) => !l.struck)
  return {
    debit: roundOre(live.reduce((sum, l) => sum + amountOf(l.debit_amount), 0)),
    credit: roundOre(live.reduce((sum, l) => sum + amountOf(l.credit_amount), 0)),
  }
}

/** Whether a line's own text says something its account name and the verifikat's texts do not. */
export function lineTextAddsSomething(
  text: string | null | undefined,
  accountName: string | null | undefined,
  redundantTexts: ReadonlyArray<string | null | undefined> = [],
): boolean {
  const own = text?.trim().toLowerCase()
  if (!own) return false
  if (accountName && own === accountName.trim().toLowerCase()) return false
  return !redundantTexts.some((r) => r && r.trim().toLowerCase() === own)
}

/**
 * The read-only kontering of a verifikat: Konto (number and name), Text,
 * Debet, Kredit, and optionally a Summa row. One table for every surface
 * that shows the rows a booking posts or posted (the verifikat list foldout,
 * approval cards, payment and salary previews, the year-end closing preview),
 * in the verifikat list's dry-table idiom. Amounts are SEK, the bookkeeping
 * home currency: two decimals and no sign as in the ledger, or kronor on a
 * confirm surface (`withCurrency`); a foreign line shows its original amount
 * under the SEK figure.
 */
export function VoucherLinesTable({
  lines,
  showTotals = false,
  redundantTexts = [],
  maxRows,
  accountNames,
  withCurrency = false,
  swedish = false,
  'aria-label': ariaLabel,
  className,
}: VoucherLinesTableProps) {
  const tVoucher = useTranslations('voucher_lines')
  const head = (key: keyof typeof SWEDISH_HEADS) => (swedish ? SWEDISH_HEADS[key] : tVoucher(key))
  const moreRows = (count: number) =>
    swedish ? `+ ${count} ${count === 1 ? 'rad' : 'rader'} till` : tVoucher('more_rows', { count })
  const shown = maxRows != null ? lines.slice(0, maxRows) : lines
  const hidden = lines.length - shown.length
  const totals = voucherLinesTotals(lines)
  const money = (amount: number) => (withCurrency ? formatCurrency(amount, 'SEK') : formatAmount(amount))

  return (
    <table className={cn('w-full border-collapse text-[12.5px]', className)} aria-label={ariaLabel}>
      <thead>
        <tr>
          {/* No fixed width and no nowrap on Konto: a long account name
              wraps instead of pushing Debet and Kredit out of a narrow
              review panel behind a hidden sideways scroll (crm#1232). Where
              there is room the column still sizes to the name on one line. */}
          <th className={VTH_CLASS}>{head('account')}</th>
          <th className={VTH_CLASS}>{head('description')}</th>
          <th className={cn(VTH_CLASS, 'text-right')}>{head('debit')}</th>
          <th className={cn(VTH_CLASS, 'pr-0 text-right')}>{head('credit')}</th>
        </tr>
      </thead>
      <tbody>
        {shown.map((line, i) => {
          const debit = amountOf(line.debit_amount)
          const credit = amountOf(line.credit_amount)
          const text = line.description?.trim() ?? ''
          const givenName = line.account_name || accountNames?.[line.account_number] || null
          const accountName = givenName || (accountNames ? null : getAccountDescription(line.account_number)?.name)
          const showText = lineTextAddsSomething(text, accountName, redundantTexts)
          const strike = line.struck ? 'line-through decoration-muted-foreground/70' : undefined
          const amountCell = (amount: number) =>
            amount > 0 ? (
              <>
                <span className={strike}>{money(amount)}</span>
                {line.foreignAmount && (
                  <span className="block text-xs text-muted-foreground tabular-nums">{line.foreignAmount}</span>
                )}
              </>
            ) : null
          return (
            <tr key={line.key ?? i} className={line.struck ? 'text-muted-foreground' : undefined}>
              <td className={cn(VTD_CLASS, strike)}>
                {accountNames ? (
                  <>
                    <span className="font-mono text-sm">{line.account_number}</span>
                    {givenName && <span className="ml-1">{givenName}</span>}
                  </>
                ) : (
                  <AccountNumber number={line.account_number} name={givenName || undefined} showName />
                )}
              </td>
              <td className={cn(VTD_CLASS, 'text-muted-foreground')}>
                {showText && <span className={strike}>{text}</span>}
                {line.extra && <span className={cn(showText && 'ml-2')}>{line.extra}</span>}
              </td>
              <td className={cn(VTD_CLASS, 'text-right tabular-nums whitespace-nowrap')}>{amountCell(debit)}</td>
              <td className={cn(VTD_CLASS, 'pr-0 text-right tabular-nums whitespace-nowrap')}>{amountCell(credit)}</td>
            </tr>
          )
        })}
        {hidden > 0 && (
          <tr>
            <td colSpan={4} className={cn(VTD_CLASS, 'pr-0 text-center text-muted-foreground')}>
              {moreRows(hidden)}
            </td>
          </tr>
        )}
        {showTotals && (
          <tr>
            <td colSpan={2} className="py-[7px] pr-4 font-medium">{head('total')}</td>
            <td className="py-[7px] pr-4 text-right tabular-nums font-medium whitespace-nowrap">
              {money(totals.debit)}
            </td>
            <td className="py-[7px] text-right tabular-nums font-medium whitespace-nowrap">
              {money(totals.credit)}
            </td>
          </tr>
        )}
      </tbody>
    </table>
  )
}
