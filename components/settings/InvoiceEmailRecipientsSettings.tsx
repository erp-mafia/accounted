'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/components/ui/use-toast'
import {
  EMAIL_PATTERN,
  MAX_INVOICE_EMAIL_COPY_RECIPIENTS,
  parseInvoiceRecipientText,
} from '@/lib/invoices/email-recipients'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { useCompany } from '@/contexts/CompanyContext'
import type { CompanySettings } from '@/types'

interface InvoiceEmailRecipientsSettingsProps {
  settings: CompanySettings
  onUpdate: (updates: Partial<CompanySettings>) => void
}

function listText(addresses: readonly string[]): string {
  return addresses.join('\n')
}

export function InvoiceEmailRecipientsSettings({
  settings,
  onUpdate,
}: InvoiceEmailRecipientsSettingsProps) {
  const t = useTranslations('settings_invoice_email_recipients')
  const { toast } = useToast()
  const { role } = useCompany()
  const effectiveCc = settings.invoice_email_cc_addresses ?? (
    settings.email ? [settings.email] : []
  )
  const effectiveBcc = settings.invoice_email_bcc_addresses ?? []
  const serverCcText = listText(effectiveCc)
  const serverBccText = listText(effectiveBcc)
  const [ccText, setCcText] = useState(serverCcText)
  const [bccText, setBccText] = useState(serverBccText)
  const [isSaving, setIsSaving] = useState(false)
  const previousServerText = useRef({ cc: serverCcText, bcc: serverBccText })

  useEffect(() => {
    const previous = previousServerText.current
    setCcText((current) => current === previous.cc ? serverCcText : current)
    setBccText((current) => current === previous.bcc ? serverBccText : current)
    previousServerText.current = { cc: serverCcText, bcc: serverBccText }
  }, [serverBccText, serverCcText])

  if (role !== 'owner' && role !== 'admin') return null

  async function save() {
    const cc = parseInvoiceRecipientText(ccText)
    const bcc = parseInvoiceRecipientText(bccText)
    const invalid = [...cc, ...bcc].find((address) => !EMAIL_PATTERN.test(address))

    if (invalid) {
      toast({
        title: t('invalid_title'),
        description: t('invalid_description', { address: invalid }),
        variant: 'destructive',
      })
      return
    }
    if (cc.length + bcc.length > MAX_INVOICE_EMAIL_COPY_RECIPIENTS) {
      toast({
        title: t('too_many_title'),
        description: t('too_many_description', { count: MAX_INVOICE_EMAIL_COPY_RECIPIENTS }),
        variant: 'destructive',
      })
      return
    }

    setIsSaving(true)
    try {
      const response = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          invoice_email_cc_addresses: cc,
          invoice_email_bcc_addresses: bcc,
        }),
      })
      if (!response.ok) {
        const result = await response.json()
        throw new Error(typeof result.error === 'string' ? result.error : t('save_failed'))
      }

      onUpdate({
        invoice_email_cc_addresses: cc,
        invoice_email_bcc_addresses: bcc,
      })
      setCcText(listText(cc))
      setBccText(listText(bcc))
      toast({ title: t('saved_title'), description: t('saved_description') })
    } catch (error) {
      toast({
        title: t('save_failed_title'),
        description: error instanceof Error ? getUserErrorMessage(error) : t('save_failed'),
        variant: 'destructive',
      })
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <section className="space-y-4">
      <div className="space-y-2">
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          {t('heading')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('description')}</p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="invoice-email-cc">{t('cc_label')}</Label>
          <Textarea
            id="invoice-email-cc"
            value={ccText}
            onChange={(event) => setCcText(event.target.value)}
            placeholder={t('cc_placeholder')}
            rows={3}
          />
          <p className="text-xs text-muted-foreground">{t('cc_hint')}</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="invoice-email-bcc">{t('bcc_label')}</Label>
          <Textarea
            id="invoice-email-bcc"
            value={bccText}
            onChange={(event) => setBccText(event.target.value)}
            placeholder={t('bcc_placeholder')}
            rows={3}
          />
          <p className="text-xs text-muted-foreground">{t('bcc_hint')}</p>
        </div>
      </div>

      <div className="flex justify-end">
        <Button type="button" onClick={save} disabled={isSaving}>
          {isSaving ? t('saving') : t('save')}
        </Button>
      </div>
    </section>
  )
}
