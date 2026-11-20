'use client'

import { useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { DetailSection } from '@/components/ui/detail-section'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/components/ui/use-toast'
import { customerExclusionOffered, customerExclusionPath } from '@/lib/collections/customer-exclusion'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { useCollectionsAvailability } from './collections-client'

/**
 * "Skicka aldrig till inkasso" on the customer page: keeps the customer's
 * invoices out of the daily collections batch and out of a handover from
 * the invoice. Shown only while collections
 * is offered to the company (the route answers on the same rule).
 */
export function CustomerCollectionsExclusion({
  customerId,
  excluded,
  canWrite,
  onSaved,
}: {
  customerId: string
  excluded: boolean
  canWrite: boolean
  onSaved: (excluded: boolean) => void
}) {
  const t = useTranslations('customers')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const availability = useCollectionsAvailability()
  const [saving, setSaving] = useState(false)

  if (!customerExclusionOffered(availability?.start)) return null

  async function save(next: boolean) {
    setSaving(true)
    try {
      const res = await fetch(customerExclusionPath(customerId), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ excluded: next }),
      })
      const json = (await res.json().catch(() => null)) as { data?: { collections_excluded?: boolean } } | null
      if (!res.ok) {
        toast({ title: t('collections_excluded_failed'), description: getErrorMessage(json, { statusCode: res.status, locale }), variant: 'destructive' })
        return
      }
      const saved = json?.data?.collections_excluded === true
      onSaved(saved)
      toast({ title: t(saved ? 'collections_excluded_on' : 'collections_excluded_off') })
    } catch (error) {
      toast({ title: t('collections_excluded_failed'), description: getErrorMessage(error, { locale }), variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <DetailSection kicker={t('collections_section')}>
      <label className="flex items-start justify-between gap-4 py-2 text-[13px]">
        <span className="min-w-0">
          <span className="block">{t('collections_excluded_label')}</span>
          <span className="mt-0.5 block text-xs text-muted-foreground">{t('collections_excluded_help')}</span>
        </span>
        <Switch
          checked={excluded}
          disabled={!canWrite || saving}
          onCheckedChange={(next) => void save(next)}
          aria-label={t('collections_excluded_label')}
          className="mt-0.5 shrink-0"
        />
      </label>
    </DetailSection>
  )
}
