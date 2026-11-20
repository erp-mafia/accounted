'use client'

import { useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { HelpPopover } from '@/components/ui/help-popover'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { useToast } from '@/components/ui/use-toast'
import { formatBankgiroNumber } from '@/lib/bankgiro/luhn'
import type { ErrorLocale } from '@/lib/errors/get-error-message'
import { AutogiroSection } from './AutogiroSection'
import { jsonRequest, requestAutogiro } from './client'
import type { AutogiroSettings } from './types'

/**
 * Avtal: the company's Autogiro agreement (Bankgirot Kundnummer and the
 * receiving bankgiro). An inline form until it is entered, then one quiet
 * line with Ändra. Entering or changing it needs the rollout (`enabled`).
 */
export function AutogiroAgreementSection({
  settings,
  enabled,
  canWrite,
  onSaved,
}: {
  settings: AutogiroSettings | null
  enabled: boolean
  canWrite: boolean
  onSaved: () => void
}) {
  const t = useTranslations('autogiro')
  const tCommon = useTranslations('common')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const [editing, setEditing] = useState(false)
  const [customerNumber, setCustomerNumber] = useState(settings?.customer_number ?? '')
  const [bankgiro, setBankgiro] = useState(settings ? formatBankgiroNumber(settings.bankgiro) : '')
  const [saving, setSaving] = useState(false)

  const canEdit = enabled && canWrite
  const showForm = canEdit && (settings === null || editing)

  function startEdit() {
    setCustomerNumber(settings?.customer_number ?? '')
    setBankgiro(settings ? formatBankgiroNumber(settings.bankgiro) : '')
    setEditing(true)
  }

  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (saving) return
    setSaving(true)
    const result = await requestAutogiro<{ settings: AutogiroSettings }>(
      '/api/invoices/autogiro/settings',
      jsonRequest('PUT', { customer_number: customerNumber.trim(), bankgiro: bankgiro.trim() }),
      locale,
    )
    setSaving(false)
    if (!result.ok) {
      toast({ title: t('agreement_save_failed'), description: result.message, variant: 'destructive' })
      return
    }
    toast({ title: t('agreement_saved') })
    setEditing(false)
    onSaved()
  }

  return (
    <AutogiroSection
      title={t('agreement_title')}
      help={
        <HelpPopover>
          <div className="space-y-2">
            <p>{t('agreement_help_numbers')}</p>
            <p>{t('agreement_help_bank')}</p>
          </div>
        </HelpPopover>
      }
    >
      {showForm ? (
        <form onSubmit={(event) => void save(event)} className="flex flex-wrap items-end gap-4">
          <div className="space-y-2">
            <Label htmlFor="autogiro-customer-number">{t('agreement_customer_number')}</Label>
            <Input
              id="autogiro-customer-number"
              inputMode="numeric"
              autoComplete="off"
              value={customerNumber}
              onChange={(event) => setCustomerNumber(event.target.value)}
              className="w-48"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="autogiro-bankgiro">{t('agreement_bankgiro')}</Label>
            <Input
              id="autogiro-bankgiro"
              inputMode="numeric"
              autoComplete="off"
              placeholder="5050-1055"
              value={bankgiro}
              onChange={(event) => setBankgiro(event.target.value)}
              className="w-48"
              required
            />
          </div>
          <div className="flex gap-2">
            <Button type="submit" loading={saving}>
              {tCommon('save')}
            </Button>
            {settings && (
              <Button type="button" variant="ghost" disabled={saving} onClick={() => setEditing(false)}>
                {tCommon('cancel')}
              </Button>
            )}
          </div>
        </form>
      ) : settings ? (
        <p className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[13px]">
          <span>
            <span className="text-muted-foreground">{t('agreement_customer_number')}</span>{' '}
            <span className="tabular-nums">{settings.customer_number}</span>
          </span>
          <span>
            <span className="text-muted-foreground">{t('agreement_bankgiro')}</span>{' '}
            <span className="tabular-nums">{formatBankgiroNumber(settings.bankgiro)}</span>
          </span>
          {canEdit && (
            <button type="button" className={QUIET_LINK_CLASS} onClick={startEdit}>
              {t('agreement_change')}
            </button>
          )}
        </p>
      ) : (
        <p className="text-[13px] text-muted-foreground">{t('agreement_missing')}</p>
      )}
    </AutogiroSection>
  )
}
