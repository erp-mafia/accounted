'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { HelpPopover } from '@/components/ui/help-popover'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { DestructiveConfirmDialog } from '@/components/ui/destructive-confirm-dialog'
import { HOVER_REVEAL_CLASS, QUIET_LINK_CLASS, TD_CLASS, TH_CLASS } from '@/components/ui/dry-table'
import { useToast } from '@/components/ui/use-toast'
import CustomerCombobox from '@/components/customers/CustomerCombobox'
import { useCustomers } from '@/lib/reference-data/hooks'
import type { ErrorLocale } from '@/lib/errors/get-error-message'
import { cn } from '@/lib/utils'
import { AutogiroSection } from './AutogiroSection'
import { jsonRequest, requestAutogiro } from './client'
import { MANDATE_STATUS_VARIANT } from './labels'
import { useCancelMandate } from './use-cancel-mandate'
import type { AutogiroMandateRow, OverviewMandate } from './types'

/**
 * Medgivanden: every payer number the company has at Bankgirot, the customer
 * it belongs to, and its status. A payer read from Bankgirot that matched no
 * customer is linked here; an active or pending one can be cancelled
 * (Makulera), which downloads the file for the bank.
 */
export function AutogiroMandatesSection({
  mandates,
  canWrite,
  onChanged,
}: {
  mandates: OverviewMandate[]
  canWrite: boolean
  onChanged: () => void
}) {
  const t = useTranslations('autogiro')
  const [linking, setLinking] = useState<OverviewMandate | null>(null)
  const { cancelMandate, dialogProps } = useCancelMandate(onChanged)
  // Newest first: the overview reads them oldest first.
  const rows = [...mandates].reverse()

  return (
    <AutogiroSection
      title={t('mandates_title')}
      count={mandates.length}
      help={
        <HelpPopover>
          <div className="space-y-2">
            <p>{t('mandates_help_link')}</p>
            <p>{t('mandates_help_add')}</p>
          </div>
        </HelpPopover>
      }
    >
      {rows.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">{t('mandates_empty')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                <th className={TH_CLASS}>{t('col_payer_number')}</th>
                <th className={TH_CLASS}>{t('col_payer_name')}</th>
                <th className={TH_CLASS}>{t('col_customer')}</th>
                <th className={TH_CLASS}>{t('col_status')}</th>
                <th className={cn(TH_CLASS, 'w-full')}>{t('col_status_text')}</th>
                <th className={TH_CLASS} aria-hidden="true"></th>
              </tr>
            </thead>
            <tbody className="stagger-enter">
              {rows.map((mandate) => {
                const variant = MANDATE_STATUS_VARIANT[mandate.status]
                const cancellable = mandate.status === 'active' || mandate.status === 'pending'
                return (
                  <tr key={mandate.id} className="group transition-colors duration-150 hover:bg-secondary/35">
                    <td className={cn(TD_CLASS, 'whitespace-nowrap tabular-nums')}>{mandate.payer_number}</td>
                    <td data-ph-mask="" className={cn(TD_CLASS, 'whitespace-nowrap')}>
                      {mandate.payer_name ?? <span className="text-muted-foreground">-</span>}
                    </td>
                    <td className={cn(TD_CLASS, 'whitespace-nowrap')}>
                      {mandate.customer_id ? (
                        <span className="inline-flex items-baseline gap-3">
                          <Link href={`/customers/${mandate.customer_id}`} className="hover:underline">
                            {mandate.customer_name ?? t('customer_unnamed')}
                          </Link>
                          {canWrite && (
                            <button type="button" className={cn(QUIET_LINK_CLASS, HOVER_REVEAL_CLASS)} onClick={() => setLinking(mandate)}>
                              {t('mandate_change_customer')}
                            </button>
                          )}
                        </span>
                      ) : canWrite ? (
                        <Button type="button" size="sm" variant="outline" onClick={() => setLinking(mandate)}>
                          {t('mandate_link_customer')}
                        </Button>
                      ) : (
                        <span className="text-attn">{t('customer_not_linked')}</span>
                      )}
                    </td>
                    <td className={cn(TD_CLASS, 'whitespace-nowrap')}>
                      {variant ? (
                        <Badge variant={variant} className="font-normal">
                          {t(`mandate_status_${mandate.status}`)}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground">{t(`mandate_status_${mandate.status}`)}</span>
                      )}
                    </td>
                    <td className={cn(TD_CLASS, 'max-w-0')}>
                      {mandate.status_text && (
                        <span className="block truncate text-[12.5px] text-muted-foreground" title={mandate.status_text}>
                          {mandate.status_text}
                        </span>
                      )}
                    </td>
                    <td className={cn(TD_CLASS, 'whitespace-nowrap text-right')}>
                      {canWrite && cancellable && (
                        <button
                          type="button"
                          className={cn(QUIET_LINK_CLASS, HOVER_REVEAL_CLASS)}
                          onClick={() => void cancelMandate(mandate)}
                        >
                          {t('mandate_cancel')}
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <DestructiveConfirmDialog {...dialogProps} />
      {linking && (
        <LinkCustomerDialog
          mandate={linking}
          onClose={() => setLinking(null)}
          onLinked={() => {
            setLinking(null)
            onChanged()
          }}
        />
      )}
    </AutogiroSection>
  )
}

/** Picks the customer a payer number belongs to, or clears the link. */
function LinkCustomerDialog({
  mandate,
  onClose,
  onLinked,
}: {
  mandate: OverviewMandate
  onClose: () => void
  onLinked: () => void
}) {
  const t = useTranslations('autogiro')
  const tCommon = useTranslations('common')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const { customers, isLoading } = useCustomers({ keepId: mandate.customer_id })
  const [customerId, setCustomerId] = useState(mandate.customer_id ?? '')
  const [saving, setSaving] = useState(false)

  async function save() {
    setSaving(true)
    const result = await requestAutogiro<{ mandate: AutogiroMandateRow }>(
      `/api/invoices/autogiro/mandates/${mandate.id}`,
      jsonRequest('PATCH', { customer_id: customerId || null }),
      locale,
    )
    setSaving(false)
    if (!result.ok) {
      toast({ title: t('mandate_link_failed'), description: result.message, variant: 'destructive' })
      return
    }
    toast({ title: customerId ? t('mandate_linked') : t('mandate_unlinked') })
    onLinked()
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('mandate_link_title', { payer: mandate.payer_number })}</DialogTitle>
          <DialogDescription>{t('mandate_link_description')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="autogiro-link-customer">{t('col_customer')}</Label>
          <CustomerCombobox
            id="autogiro-link-customer"
            value={customerId}
            customers={customers}
            keepId={mandate.customer_id}
            onChange={setCustomerId}
            loading={isLoading}
            noneLabel={mandate.customer_id ? t('mandate_no_customer') : undefined}
          />
        </div>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button type="button" variant="outline" disabled={saving} onClick={onClose}>
            {tCommon('cancel')}
          </Button>
          <Button
            type="button"
            loading={saving}
            disabled={customerId === (mandate.customer_id ?? '')}
            onClick={() => void save()}
          >
            {tCommon('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
