'use client'

import { useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import type { UsageKind } from '@/lib/usage/kinds'
import { formatCurrency } from '@/lib/utils'

const MESSAGE_MAX = 2000

/**
 * Where a paid service reaches what the month includes: the person asks for
 * more (POST /api/billing/usage/requests), support gets the request with the
 * company's numbers, and an operator opens the charge for the company. Bank
 * payments ask through their own dialog (RequestMorePaymentsDialog).
 */
export function UsageLimitDialog({
  kind,
  included,
  unitPriceOre,
  open,
  onOpenChange,
}: {
  kind: UsageKind
  included: number
  unitPriceOre: number
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const t = useTranslations('usage_limit')
  const tKind = useTranslations('settings_billing')
  const locale = useLocale()
  const { toast } = useToast()
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const numbers = { service: tKind(`usage_kind_${kind}`), included, price: formatCurrency(unitPriceOre / 100) }

  async function send() {
    setSending(true)
    try {
      const res = await fetch('/api/billing/usage/requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, message: message.trim() || null }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        toast({ title: t('failed'), description: getErrorMessage(body, { locale: locale as ErrorLocale }), variant: 'destructive' })
        return
      }
      toast({ title: t('sent', numbers) })
      onOpenChange(false)
    } finally {
      setSending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title', numbers)}</DialogTitle>
          <DialogDescription>{t('body', numbers)}</DialogDescription>
        </DialogHeader>
        <label className="grid gap-1.5 text-[13px]">
          <span className="text-muted-foreground">{t('message_label')}</span>
          <Textarea value={message} maxLength={MESSAGE_MAX} rows={3} onChange={(e) => setMessage(e.target.value)} placeholder={t('message_placeholder')} />
        </label>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button onClick={() => void send()} disabled={sending}>
            {t('send')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
