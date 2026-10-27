'use client'

import { useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { DetailSection } from '@/components/ui/detail-section'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/components/ui/use-toast'
import { useBranding } from '@/lib/branding/brand-context'
import { REMINDERS_SENDING_ENABLED } from '@/lib/invoices/reminders-enabled'
import { errorLocale, saveCustomerRemindersExcluded } from './reminders-client'

interface CustomerRemindersExclusionProps {
  customerId: string
  excluded: boolean
  canWrite: boolean
  onSaved: (excluded: boolean) => void
}

/**
 * "Skicka aldrig påminnelser" on the customer page (customers.reminders_excluded):
 * the reminder policy then skips every invoice of the customer, in the
 * daily batch and when a person picks one. Kept apart from the collections
 * flag beside it. Renders nothing while REMINDERS_SENDING_ENABLED is false.
 */
export function CustomerRemindersExclusion(props: CustomerRemindersExclusionProps) {
  if (!REMINDERS_SENDING_ENABLED) return null
  return <CustomerRemindersExclusionSwitch {...props} />
}

function CustomerRemindersExclusionSwitch({ customerId, excluded, canWrite, onSaved }: CustomerRemindersExclusionProps) {
  const t = useTranslations('reminders_setup')
  const locale = errorLocale(useLocale())
  const { appName } = useBranding()
  const { toast } = useToast()
  const [saving, setSaving] = useState(false)

  async function save(next: boolean) {
    setSaving(true)
    try {
      const result = await saveCustomerRemindersExcluded(locale, customerId, next)
      if (!result.ok) {
        toast({ title: t('save_failed'), description: result.message, variant: 'destructive' })
        return
      }
      onSaved(result.data.reminders_excluded)
      toast({ title: t(result.data.reminders_excluded ? 'customer_excluded_on' : 'customer_excluded_off') })
    } finally {
      setSaving(false)
    }
  }

  return (
    <DetailSection kicker={t('customer_section')}>
      <label className="flex items-start justify-between gap-4 py-2 text-[13px]">
        <span className="min-w-0">
          <span className="block">{t('customer_excluded_label')}</span>
          <span className="mt-1 block text-[12.5px] text-muted-foreground">{t('customer_excluded_help', { appName })}</span>
        </span>
        <Switch
          checked={excluded}
          disabled={!canWrite || saving}
          onCheckedChange={(next) => void save(next)}
          aria-label={t('customer_excluded_label')}
          className="shrink-0"
        />
      </label>
    </DetailSection>
  )
}
