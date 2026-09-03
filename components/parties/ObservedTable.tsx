'use client'

import { useTranslations } from 'next-intl'
import { TD_CLASS, TH_CLASS } from '@/components/ui/dry-table'
import type { ObservedRow, Register } from '@/lib/parties/register'
import { formatCurrency } from '@/lib/utils'
import { AccountNub } from './AccountNub'
import { rhythmLabel } from './format'

function money(n: number): string {
  return n ? formatCurrency(n) : ''
}

/**
 * "Bara i bokföringen": counterparts the ledger names that no party claims.
 * Computed, never stored; the generic band keeps unattributed spend visible
 * without inventing a supplier for "Inköp av varor".
 */
export function ObservedTable({ rows, generic }: { rows: ObservedRow[]; generic: Register['generic'] }) {
  const t = useTranslations('parties')
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr>
            <th className={TH_CLASS}>{t('th_name')}</th>
            <th className={TH_CLASS}>{t('th_rhythm')}</th>
            <th className={TH_CLASS}>{t('th_vouchers')}</th>
            <th className={TH_CLASS}>{t('th_account')}</th>
            <th className={`${TH_CLASS} text-right`}>{t('th_revenue')}</th>
            <th className={`${TH_CLASS} text-right`}>{t('th_expense')}</th>
          </tr>
        </thead>
        <tbody className="stagger-enter">
          {rows.map((row) => (
            <tr key={row.key} className="transition-colors duration-150 hover:bg-secondary/35">
              <td className={`${TD_CLASS} whitespace-nowrap`}>
                <span className="text-foreground">{row.name}</span>
                {row.label === 'unsure' ? <span className="ml-2 text-xs text-muted-foreground">{t('uncertain_name')}</span> : null}
              </td>
              <td className={`${TD_CLASS} whitespace-nowrap text-muted-foreground`}>{rhythmLabel(t, row.stats.rhythm)}</td>
              <td className={`${TD_CLASS} whitespace-nowrap text-muted-foreground tabular-nums`}>{t('vouchers_count', { count: row.stats.occurrences })}</td>
              <td className={TD_CLASS}>
                <AccountNub account={row.stats.dominantAccount} />
              </td>
              <td className={`${TD_CLASS} text-right tabular-nums`}>{money(row.stats.revenueSek)}</td>
              <td className={`${TD_CLASS} text-right tabular-nums`}>{money(row.stats.expenseSek)}</td>
            </tr>
          ))}
          {generic.count > 0 ? (
            <tr className="bg-muted/30">
              <td colSpan={5} className="px-4 py-2 text-[12px] text-muted-foreground">
                <span className="font-semibold">{t('generic_band', { count: generic.count })}</span>
                <span className="ml-2">{t('generic_band_description', { examples: generic.examples.join(' · ') })}</span>
              </td>
              <td className="px-4 py-2 text-right text-[12px] text-muted-foreground tabular-nums">{money(generic.expenseSek)}</td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  )
}
