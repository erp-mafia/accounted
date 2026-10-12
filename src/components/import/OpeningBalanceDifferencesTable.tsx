'use client'

import { useTranslations } from 'next-intl'
import { TD_CLASS, TH_CLASS } from '@/components/ui/dry-table'
import { formatCurrency } from '@/lib/utils'

export interface OpeningBalanceDifferenceRow {
  account: string
  left: number
  right: number
  /** right minus left. */
  difference: number
}

interface OpeningBalanceDifferencesTableProps {
  rows: OpeningBalanceDifferenceRow[]
  leftLabel: string
  rightLabel: string
  /** Rows shown before the rest collapse into a count. */
  limit?: number
}

/**
 * Opening balances per account, side by side (crm#1099): the SIE file's #IB
 * against what the books carry forward, or the file's #IB against its own
 * previous-year closing balance. Debit-positive, as booked.
 */
export function OpeningBalanceDifferencesTable({
  rows,
  leftLabel,
  rightLabel,
  limit = 12,
}: OpeningBalanceDifferencesTableProps) {
  const t = useTranslations('import')
  const shown = rows.slice(0, limit)

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr>
            <th className={TH_CLASS}>{t('ib_continuity_col_account')}</th>
            <th className={`${TH_CLASS} text-right`}>{leftLabel}</th>
            <th className={`${TH_CLASS} text-right`}>{rightLabel}</th>
            <th className={`${TH_CLASS} text-right`}>{t('ib_continuity_col_difference')}</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((row) => (
            <tr key={row.account}>
              <td className={`${TD_CLASS} font-mono`}>{row.account}</td>
              <td className={`${TD_CLASS} text-right tabular-nums`}>{formatCurrency(row.left)}</td>
              <td className={`${TD_CLASS} text-right tabular-nums`}>{formatCurrency(row.right)}</td>
              <td className={`${TD_CLASS} text-right tabular-nums text-warning`}>{formatCurrency(row.difference)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > shown.length && (
        <p className="mt-2 text-muted-foreground">{t('ib_continuity_more', { count: rows.length - shown.length })}</p>
      )}
    </div>
  )
}
