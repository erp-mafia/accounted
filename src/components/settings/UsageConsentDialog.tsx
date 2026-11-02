'use client'

import { useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { useCompany } from '@/contexts/CompanyContext'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import type { UsageKind } from '@/lib/usage/kinds'
import { formatCurrency } from '@/lib/utils'

/**
 * Where a paid service reaches what the month includes: the person accepts
 * that more costs the unit price, billed in arrears, until someone turns it
 * off under Abonnemang (PUT /api/billing/usage/consent). Only an admin can
 * accept; anyone else is told to ask one.
 */
export function UsageConsentDialog({
  kind,
  included,
  unitPriceOre,
  open,
  onOpenChange,
  onAccepted,
}: {
  kind: UsageKind
  included: number
  unitPriceOre: number
  open: boolean
  onOpenChange: (open: boolean) => void
  /** After the acceptance is recorded: the caller retries or rereads. */
  onAccepted: () => void
}) {
  const t = useTranslations('usage_consent')
  const tKind = useTranslations('settings_billing')
  const locale = useLocale()
  const { toast } = useToast()
  const { role } = useCompany()
  const [saving, setSaving] = useState(false)
  const isAdmin = role === 'owner' || role === 'admin'
  const numbers = { service: tKind(`usage_kind_${kind}`), included, price: formatCurrency(unitPriceOre / 100) }

  async function accept() {
    setSaving(true)
    try {
      const res = await fetch('/api/billing/usage/consent', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, accepted: true }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        toast({ title: t('failed'), description: getErrorMessage(body, { locale: locale as ErrorLocale }), variant: 'destructive' })
        return
      }
      toast({ title: t('accepted', numbers) })
      onOpenChange(false)
      onAccepted()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title', numbers)}</DialogTitle>
          <DialogDescription>{t('body', numbers)}</DialogDescription>
        </DialogHeader>
        {!isAdmin && <p className="text-[13px] text-muted-foreground">{t('admin_only')}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {isAdmin ? t('cancel') : t('close')}
          </Button>
          {isAdmin && (
            <Button onClick={() => void accept()} disabled={saving}>
              {t('accept')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
