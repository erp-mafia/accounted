'use client'

import { Fragment, useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { TH_CLASS, TD_CLASS } from '@/components/ui/dry-table'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import type { ReconciliationAccount } from '@/lib/reconciliation/schemas'
import { AccountLogo } from './ReconciliationRail'

/**
 * Shell v2 landing of the Avstämning page (concept P.recon): one row per
 * account, what its outside source is and when it was read, how many rows
 * still need a look, what is unexplained, when it was last signed off, and
 * the one button that opens the flow for it. The balance accounts without a
 * feed fold under their own group so the bank rows stay in view.
 */

interface ReconciliationTableProps {
  accounts: ReconciliationAccount[]
  onSelect: (accountKey: string) => void
  /** Rendered under the table: the way to the pärm the accounts feed. */
  footer?: ReactNode
}

export function ReconciliationTable({ accounts, onSelect, footer }: ReconciliationTableProps) {
  const t = useTranslations('reconciliation')
  const tAcc = useTranslations('accounts_v2')
  const fed = accounts.filter((a) => a.kind !== 'manual')
  const manual = accounts.filter((a) => a.kind === 'manual')
  const [manualOpen, setManualOpen] = useState(false)

  const openRows = (a: ReconciliationAccount) => {
    const c = a.status?.open_counts
    return c ? c.proposed + c.unmatched_external + c.unmatched_ledger : 0
  }

  const renderRow = (a: ReconciliationAccount) => {
    const open = openRows(a)
    const unexplained = a.status?.unexplained_difference ?? null
    // Green only when the account is reconciled: a zero with open rows is
    // not settled, just not yet explained.
    const tone =
      unexplained == null
        ? 'text-muted-foreground'
        : a.status?.state === 'reconciled'
          ? 'text-success'
          : Math.abs(unexplained) >= 0.005
            ? 'text-warning'
            : ''
    const synced = a.kind === 'manual' ? null : a.source.synced_at
    return (
      <tr
        key={a.account_key}
        className={cn('group transition-colors duration-150 hover:bg-secondary/35', a.superseded_by && 'opacity-60')}
      >
        <td className={cn(TD_CLASS, '!pl-0')}>
          <button type="button" onClick={() => onSelect(a.account_key)} className="flex items-center gap-3 text-left">
            <AccountLogo account={a} className="h-7 w-7 text-[10px]" />
            <span className="min-w-0">
              <span className="block truncate font-medium" data-ph-mask>
                {a.name}
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                <span data-ph-mask>{a.account_number}</span>
                {a.currency !== 'SEK' ? ` · ${a.currency}` : ''}
                {a.superseded_by ? ` · ${t('rail_superseded')}` : ''}
              </span>
            </span>
          </button>
        </td>
        <td className={cn(TD_CLASS, 'hidden whitespace-nowrap text-muted-foreground sm:table-cell')}>
          {a.kind === 'manual'
            ? tAcc('source_manual')
            : `${tAcc(`source_${a.source.type}`)} · ${synced ? t('rail_synced', { date: formatDate(synced) }) : t('rail_never_synced')}`}
        </td>
        <td className={cn(TD_CLASS, 'whitespace-nowrap')}>
          {open > 0 ? (
            <button
              type="button"
              onClick={() => onSelect(a.account_key)}
              className="rounded-full border border-border px-2.5 py-0.5 text-xs hover:bg-secondary/60"
              data-ph-mask
            >
              {t('v2_rows_open', { count: open })}
            </button>
          ) : (
            <span className="text-muted-foreground">–</span>
          )}
        </td>
        <td
          className={cn(TD_CLASS, 'whitespace-nowrap text-right tabular-nums', tone)}
          data-ph-mask
        >
          {unexplained == null ? '–' : formatCurrency(unexplained, a.currency)}
        </td>
        <td className={cn(TD_CLASS, 'whitespace-nowrap text-muted-foreground')}>
          {a.signed_off_through ? formatDate(a.signed_off_through) : t('v2_never')}
        </td>
        <td className={cn(TD_CLASS, 'whitespace-nowrap text-right !pr-0')}>
          <Button size="sm" variant="outline" className="h-7 px-3.5 text-xs" onClick={() => onSelect(a.account_key)}>
            {t('v2_reconcile')}
          </Button>
        </td>
      </tr>
    )
  }

  return (
    <div className="stagger-enter">
      <div className="-mx-5 overflow-x-auto px-5 md:-mx-6 md:px-6">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr>
              <th className={cn(TH_CLASS, '!pl-0 w-full')}>{t('v2_th_account')}</th>
              <th className={cn(TH_CLASS, 'hidden sm:table-cell')}>{t('v2_th_source')}</th>
              <th className={TH_CLASS}>{t('v2_th_open')}</th>
              <th className={cn(TH_CLASS, 'text-right')}>{t('v2_th_unexplained')}</th>
              <th className={TH_CLASS}>{t('v2_th_signed_off')}</th>
              <th className={cn(TH_CLASS, '!pr-0')} aria-hidden="true"></th>
            </tr>
          </thead>
          <tbody>
            {fed.map(renderRow)}
            {manual.length > 0 && (
              <Fragment>
                <tr className="bg-muted/30">
                  <td colSpan={6} className="px-0 py-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                    <span className="flex items-center gap-3">
                      <span>
                        {t('rail_group_manual')}
                        <span className="ml-1.5 font-normal tabular-nums text-muted-foreground/70" data-ph-mask>
                          {manual.length}
                        </span>
                      </span>
                      <button
                        type="button"
                        onClick={() => setManualOpen((v) => !v)}
                        className="normal-case tracking-normal text-[12px] font-normal text-muted-foreground underline decoration-border underline-offset-2 hover:text-foreground"
                      >
                        {manualOpen ? t('v2_hide_manual') : t('v2_show_manual', { count: manual.length })}
                      </button>
                    </span>
                  </td>
                </tr>
                {manualOpen && manual.map(renderRow)}
              </Fragment>
            )}
          </tbody>
        </table>
      </div>
      <p className="mt-3 max-w-[70ch] text-[12.5px] text-muted-foreground">{t('v2_note')}</p>
      {footer}
    </div>
  )
}
