'use client'

import React, { useMemo, useRef, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { AccountNumber } from '@/components/ui/account-number'
import { TH_CLASS } from '@/components/ui/dry-table'
import { cn, formatWholeKr } from '@/lib/utils'
import { formatAmountInput, parseAmountInput } from '@/lib/money'
import { groupGrid, rowTotal, type GridRow } from '@/lib/budgets/grid'
import { RESULT_CLASS_LABELS } from '@/lib/reports/result-class-labels'

interface Props {
  months: string[]
  /** The rows as shown: resultatrapport sign, edits laid over. */
  rows: GridRow[]
  editable: boolean
  onCellChange: (account: string, monthIndex: number, amount: number) => void
}

const NUM_CELL = 'px-2 py-1.5 text-right tabular-nums whitespace-nowrap border-b border-border'

/**
 * The budget as an account x month grid: class bands with subtotals and the
 * budgeted result, the resultatrapport's sign (revenue positive). The account
 * column sticks while the months scroll sideways, the one table on the page
 * that has to (twelve months do not fit a laptop's content column).
 */
export function BudgetGrid({ months, rows, editable, onCellChange }: Props) {
  const t = useTranslations('budget')
  const locale = useLocale()
  const model = useMemo(() => groupGrid(rows, months.length), [rows, months.length])
  const monthLabel = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'sv-SE', { month: 'short' })
    return (month: string) => fmt.format(new Date(`${month}-01T12:00:00`))
  }, [locale])
  const colCount = months.length + 2

  return (
    <div className="overflow-x-auto stagger-enter">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr>
            <th className={cn(TH_CLASS, 'sticky left-0 z-10 bg-background min-w-[220px]')}>{t('col_account')}</th>
            {months.map((m) => (
              <th key={m} className={cn(TH_CLASS, 'px-2 text-right')} title={m}>
                {monthLabel(m)}
              </th>
            ))}
            <th className={cn(TH_CLASS, 'px-2 text-right')}>{t('col_total')}</th>
          </tr>
        </thead>
        <tbody>
          {model.groups.map((group) => (
            <React.Fragment key={group.account_class}>
              <tr className="bg-muted/30">
                <td colSpan={colCount} className="px-4 py-2 text-[12.5px] font-semibold text-muted-foreground">
                  {RESULT_CLASS_LABELS[group.account_class]}
                </td>
              </tr>
              {group.rows.map((row) => (
                <tr key={row.account_number} className="hover:bg-secondary/35">
                  <td className="sticky left-0 z-10 bg-background px-4 py-1.5 border-b border-border">
                    <div className="flex items-center gap-2 min-w-0">
                      <AccountNumber number={row.account_number} name={row.account_name ?? ''} />
                      <span className="truncate max-w-[160px]">{row.account_name}</span>
                    </div>
                  </td>
                  {row.amounts.map((amount, i) => (
                    <td key={months[i]} className={cn(NUM_CELL, editable && 'p-0')}>
                      {editable ? (
                        <BudgetCell
                          value={amount}
                          label={`${row.account_number} ${months[i]}`}
                          onCommit={(next) => onCellChange(row.account_number, i, next)}
                        />
                      ) : (
                        amount !== 0 ? formatWholeKr(amount) : ''
                      )}
                    </td>
                  ))}
                  <td className={cn(NUM_CELL, 'font-medium')}>{formatWholeKr(rowTotal(row))}</td>
                </tr>
              ))}
              <tr className="font-medium">
                <td className="sticky left-0 z-10 bg-background px-4 py-1.5 border-b border-border text-muted-foreground">
                  {t('subtotal')}
                </td>
                {group.subtotal.map((v, i) => (
                  <td key={months[i]} className={NUM_CELL}>{formatWholeKr(v)}</td>
                ))}
                <td className={NUM_CELL}>{formatWholeKr(group.total)}</td>
              </tr>
            </React.Fragment>
          ))}
          <tr className="font-medium">
            <td className="sticky left-0 z-10 bg-background px-4 py-2">{t('result')}</td>
            {model.result.map((v, i) => (
              <td key={months[i]} className={cn(NUM_CELL, 'border-b-0', v >= 0 ? 'text-success' : 'text-destructive')}>
                {formatWholeKr(v)}
              </td>
            ))}
            <td className={cn(NUM_CELL, 'border-b-0', model.resultTotal >= 0 ? 'text-success' : 'text-destructive')}>
              {formatWholeKr(model.resultTotal)}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}

/**
 * One editable cell: whole kronor at rest, the exact amount while typing. A
 * value that is not one amount reverts on blur rather than being read as 0.
 */
function BudgetCell({ value, label, onCommit }: { value: number; label: string; onCommit: (next: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  const cancelled = useRef(false)
  const commit = () => {
    if (cancelled.current || draft === null) {
      cancelled.current = false
      setDraft(null)
      return
    }
    const parsed = draft.trim() === '' ? 0 : parseAmountInput(draft)
    if (parsed !== null && parsed !== value) onCommit(parsed)
    setDraft(null)
  }
  return (
    <input
      aria-label={label}
      inputMode="decimal"
      className="w-24 bg-transparent px-2 py-1.5 text-right tabular-nums outline-none focus-visible:bg-secondary/60 focus-visible:ring-1 focus-visible:ring-primary/20"
      value={draft ?? (value !== 0 ? formatWholeKr(value) : '')}
      onFocus={() => setDraft(value !== 0 ? formatAmountInput(value) : '')}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') {
          cancelled.current = true
          ;(e.target as HTMLInputElement).blur()
        }
      }}
    />
  )
}
