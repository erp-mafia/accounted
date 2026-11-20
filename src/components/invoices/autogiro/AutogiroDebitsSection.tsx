'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { AttnLine } from '@/components/ui/attn-line'
import { HelpPopover } from '@/components/ui/help-popover'
import { QUIET_LINK_CLASS, TD_CLASS, TH_CLASS } from '@/components/ui/dry-table'
import { useToast } from '@/components/ui/use-toast'
import { todayIsoStockholm } from '@/lib/dates/iso'
import type { ErrorLocale } from '@/lib/errors/get-error-message'
import { cn, formatDate, formatRowAmount } from '@/lib/utils'
import { AutogiroSection } from './AutogiroSection'
import { jsonRequest, requestAutogiro } from './client'
import { DEBIT_STATUS_VARIANT } from './labels'
import type { AutogiroDebitRow, DueAutogiroInvoice, SettleResponse } from './types'

/**
 * Dragningar: the latest debits and what Bankgirot said about each. A failed
 * or rejected debit leaves its invoice open, and the invoice is back under
 * Att dra. "Matcha mot banken" settles the debits whose day has come without
 * a report file, for a company whose bank shows the reports only in
 * Autogiro Online: each day's debits are offered to the bank rows as one
 * deposit.
 */
export function AutogiroDebitsSection({
  debits,
  due,
  canWrite,
  onChanged,
}: {
  debits: AutogiroDebitRow[]
  due: DueAutogiroInvoice[]
  canWrite: boolean
  onChanged: () => void
}) {
  const t = useTranslations('autogiro')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const [settling, setSettling] = useState(false)
  const [settled, setSettled] = useState<SettleResponse | null>(null)

  const today = todayIsoStockholm()
  const settleable = debits.some((d) => d.status === 'sent' && d.debit_date <= today)
  const dueIds = new Set(due.map((d) => d.invoice_id))
  const failedAgain = new Set(
    debits.filter((d) => (d.status === 'failed' || d.status === 'rejected') && dueIds.has(d.invoice_id)).map((d) => d.invoice_id),
  ).size

  async function settle() {
    if (settling) return
    setSettling(true)
    const result = await requestAutogiro<SettleResponse>('/api/invoices/autogiro/settle', jsonRequest('POST'), locale)
    setSettling(false)
    if (!result.ok) {
      toast({ title: t('settle_failed'), description: result.message, variant: 'destructive' })
      return
    }
    setSettled(result.data)
    onChanged()
  }

  return (
    <AutogiroSection
      title={t('debits_title')}
      help={
        <HelpPopover>
          <div className="space-y-2">
            <p>{t('debits_help_failed')}</p>
            <p>{t('debits_help_settle')}</p>
          </div>
        </HelpPopover>
      }
      action={
        canWrite && settleable ? (
          <Button type="button" variant="outline" loading={settling} onClick={() => void settle()}>
            {t('settle_action')}
          </Button>
        ) : undefined
      }
    >
      {settled && (
        <p className="text-[13px]">
          {settled.debited > 0 ? (
            <>
              {t('settle_found', { count: settled.debited })}{' '}
              <Link href="/transactions" className={QUIET_LINK_CLASS}>
                {t('settlement_confirm')}
              </Link>
            </>
          ) : (
            <span className="text-muted-foreground">{t('settle_none')}</span>
          )}
        </p>
      )}
      {failedAgain > 0 && <AttnLine>{t('debits_failed_attn', { count: failedAgain })}</AttnLine>}
      {debits.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">{t('debits_empty')}</p>
      ) : (
        <div className="-mx-2 overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                <th className={TH_CLASS}>{t('col_invoice')}</th>
                <th className={TH_CLASS}>{t('col_customer')}</th>
                <th className={TH_CLASS}>{t('col_debit_date')}</th>
                <th className={cn(TH_CLASS, 'text-right')}>{t('col_amount')}</th>
                <th className={TH_CLASS}>{t('col_status')}</th>
                <th className={cn(TH_CLASS, 'w-full')}>{t('col_status_text')}</th>
              </tr>
            </thead>
            <tbody className="stagger-enter">
              {debits.map((debit) => {
                const variant = DEBIT_STATUS_VARIANT[debit.status]
                return (
                  <tr key={debit.id} className="transition-colors duration-150 hover:bg-secondary/35">
                    <td className={cn(TD_CLASS, 'whitespace-nowrap tabular-nums')}>
                      <Link href={`/invoices/${debit.invoice_id}`} className="hover:underline">
                        {debit.invoice_number ?? t('invoice_without_number')}
                      </Link>
                    </td>
                    <td className={cn(TD_CLASS, 'max-w-[16rem]')}>
                      <span className="block truncate">{debit.customer_name ?? '-'}</span>
                    </td>
                    <td className={cn(TD_CLASS, 'whitespace-nowrap date-figures')}>{formatDate(debit.debit_date)}</td>
                    <td className={cn(TD_CLASS, 'whitespace-nowrap text-right tabular-nums')}>{formatRowAmount(debit.amount)}</td>
                    <td className={cn(TD_CLASS, 'whitespace-nowrap')}>
                      {variant ? (
                        <Badge variant={variant} className="font-normal">
                          {t(`debit_status_${debit.status}`)}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground">{t(`debit_status_${debit.status}`)}</span>
                      )}
                    </td>
                    <td className={cn(TD_CLASS, 'max-w-0')}>
                      {debit.status_text && (
                        <span className="block truncate text-xs text-muted-foreground" title={debit.status_text}>
                          {debit.status_text}
                        </span>
                      )}
                    </td>
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
