'use client'

import { useTranslations } from 'next-intl'
import { TD_CLASS, TH_CLASS } from '@/components/ui/dry-table'
import type { RegisterRow } from '@/lib/parties/register'
import { formatCurrency } from '@/lib/utils'
import { AccountNub } from './AccountNub'
import { rhythmLabel, roleLabel } from './format'

function money(n: number | undefined): string {
  return n ? formatCurrency(n) : ''
}

function underlag(t: (k: string, v?: Record<string, string | number>) => string, row: RegisterRow): string {
  const parts: string[] = []
  if (row.invoiceCount > 0) parts.push(t('invoices_count', { count: row.invoiceCount }))
  if (row.stats?.occurrences) parts.push(t('vouchers_count', { count: row.stats.occurrences }))
  return parts.join(' · ')
}

/** Moment 1: one list for confirmed parties. Roles are muted text, never chips. */
export function RegisterTable({ rows, onOpen }: { rows: RegisterRow[]; onOpen: (id: string) => void }) {
  const t = useTranslations('parties')
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr>
            <th className={TH_CLASS}>{t('th_name')}</th>
            <th className={TH_CLASS}>{t('th_role')}</th>
            <th className={TH_CLASS}>{t('th_rhythm')}</th>
            <th className={TH_CLASS}>{t('th_underlag')}</th>
            <th className={TH_CLASS}>{t('th_account')}</th>
            <th className={`${TH_CLASS} text-right`}>{t('th_revenue')}</th>
            <th className={`${TH_CLASS} text-right`}>{t('th_expense')}</th>
          </tr>
        </thead>
        <tbody className="stagger-enter">
          {rows.map((row) => (
            <tr
              key={row.id}
              className="cursor-pointer transition-colors duration-150 hover:bg-secondary/35"
              onClick={() => onOpen(row.id)}
            >
              <td className={`${TD_CLASS} whitespace-nowrap`}>
                <button
                  type="button"
                  className="text-left font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={(e) => {
                    e.stopPropagation()
                    onOpen(row.id)
                  }}
                  aria-label={t('open_dossier', { name: row.displayName })}
                >
                  {row.displayName}
                </button>
              </td>
              <td className={`${TD_CLASS} whitespace-nowrap text-muted-foreground`}>{roleLabel(t, row.roles)}</td>
              <td className={`${TD_CLASS} whitespace-nowrap text-muted-foreground`}>{rhythmLabel(t, row.stats?.rhythm ?? null)}</td>
              <td className={`${TD_CLASS} whitespace-nowrap text-muted-foreground tabular-nums`}>{underlag(t, row)}</td>
              <td className={TD_CLASS}>
                <AccountNub account={row.stats?.dominantAccount ?? null} />
              </td>
              <td className={`${TD_CLASS} text-right tabular-nums`}>{money(row.stats?.revenueSek)}</td>
              <td className={`${TD_CLASS} text-right tabular-nums`}>{money(row.stats?.expenseSek)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
