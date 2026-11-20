'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Checkbox } from '@/components/ui/checkbox'
import { HelpPopover } from '@/components/ui/help-popover'
import { CHECKBOX_REVEAL_CLASS, QUIET_LINK_CLASS, TD_CLASS, TH_CLASS } from '@/components/ui/dry-table'
import { cn, formatDate, formatRowAmount } from '@/lib/utils'
import { AutogiroSection } from './AutogiroSection'
import { BLOCKER_KEY } from './labels'
import type { DueAutogiroInvoice } from './types'

/**
 * Att dra: the issued invoices that announced Autogiro and still ask for
 * money, each with its payment day and amount, or why it cannot go into a
 * file now. The selection feeds "Skapa betalfil" in the page header.
 */
export function AutogiroDueSection({
  due,
  selected,
  selectable,
  onToggle,
  onToggleAll,
}: {
  due: DueAutogiroInvoice[]
  selected: ReadonlySet<string>
  /** The person can write files now (rollout, role and an agreement). */
  selectable: boolean
  onToggle: (invoiceId: string, checked: boolean) => void
  onToggleAll: (checked: boolean) => void
}) {
  const t = useTranslations('autogiro')
  const debitable = due.filter((d) => d.blocker === null)
  const allSelected = debitable.length > 0 && debitable.every((d) => selected.has(d.invoice_id))
  const anyBlocked = due.some((d) => d.blocker !== null)

  return (
    <AutogiroSection
      title={t('due_title')}
      count={due.length}
      help={
        <HelpPopover>
          <div className="space-y-2">
            <p>{t('due_help_date')}</p>
            <p>{t('due_help_file')}</p>
          </div>
        </HelpPopover>
      }
      action={
        selectable && debitable.length > 1 ? (
          <button type="button" className={QUIET_LINK_CLASS} onClick={() => onToggleAll(!allSelected)}>
            {allSelected ? t('due_select_none') : t('due_select_all', { count: debitable.length })}
          </button>
        ) : undefined
      }
    >
      {due.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">{t('due_empty')}</p>
      ) : (
        <div className="-mx-2 overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                {selectable && <th className={cn(TH_CLASS, 'w-10')} aria-hidden="true"></th>}
                <th className={TH_CLASS}>{t('col_invoice')}</th>
                <th className={cn(TH_CLASS, 'w-full')}>{t('col_customer')}</th>
                <th className={TH_CLASS}>{t('col_payer_number')}</th>
                <th className={TH_CLASS}>{t('col_debit_date')}</th>
                <th className={cn(TH_CLASS, 'text-right')}>{t('col_amount')}</th>
                {anyBlocked && <th className={TH_CLASS}>{t('col_note')}</th>}
              </tr>
            </thead>
            <tbody className="stagger-enter">
              {due.map((row) => {
                const checked = selected.has(row.invoice_id)
                const canPick = selectable && row.blocker === null
                const moved = row.debit_date !== row.due_date
                return (
                  <tr
                    key={row.invoice_id}
                    className={cn('group transition-colors duration-150 hover:bg-secondary/35', checked && 'bg-secondary/40')}
                  >
                    {selectable && (
                      <td className={cn(TD_CLASS, 'w-10 pr-0')}>
                        <span className={cn(CHECKBOX_REVEAL_CLASS, checked && 'opacity-100')}>
                          <Checkbox
                            className="border-foreground"
                            checked={checked}
                            disabled={!canPick}
                            onCheckedChange={(value) => onToggle(row.invoice_id, value === true)}
                            aria-label={t('due_select_row', { number: row.invoice_number ?? '' })}
                          />
                        </span>
                      </td>
                    )}
                    <td className={cn(TD_CLASS, 'whitespace-nowrap tabular-nums')}>
                      <Link href={`/invoices/${row.invoice_id}`} className="hover:underline">
                        {row.invoice_number ?? t('invoice_without_number')}
                      </Link>
                    </td>
                    <td className={cn(TD_CLASS, 'max-w-0')}>
                      <span className="block truncate">{row.customer_name ?? '-'}</span>
                    </td>
                    <td className={cn(TD_CLASS, 'whitespace-nowrap tabular-nums')}>{row.payer_number}</td>
                    <td
                      className={cn(TD_CLASS, 'whitespace-nowrap date-figures')}
                      title={moved ? t('debit_date_moved', { due: formatDate(row.due_date) }) : undefined}
                    >
                      {formatDate(row.debit_date)}
                      {moved && <span className="ml-1 text-muted-foreground" aria-hidden="true">*</span>}
                    </td>
                    <td className={cn(TD_CLASS, 'whitespace-nowrap text-right tabular-nums')}>{formatRowAmount(row.amount)}</td>
                    {anyBlocked && (
                      <td className={cn(TD_CLASS, 'max-w-[20rem]')}>
                        {row.blocker && (
                          <span className="block truncate text-attn" title={t(BLOCKER_KEY[row.blocker])}>
                            {t(BLOCKER_KEY[row.blocker])}
                          </span>
                        )}
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </AutogiroSection>
  )
}
