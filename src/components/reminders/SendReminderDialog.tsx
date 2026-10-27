'use client'

import { useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { REMINDERS_SENDING_ENABLED } from '@/lib/invoices/reminders-enabled'
import { mergeSendResults, type PickedSendResult } from '@/lib/reminders/turn-on'
import { createClient } from '@/lib/supabase/client'
import { ReminderMailPreview, useReminderPreview } from './ReminderMailPreview'
import { ReminderSendResults } from './ReminderSendResults'
import { errorLocale, sendPickedReminders } from './reminders-client'

/**
 * Whether the invoice came from another system (a migration_source_records
 * row, the reminder facts' own rule): null until read. An unreadable answer
 * shows no warning rather than a wrong one; the send path decides the
 * reminder itself either way.
 */
function useInvoiceImported(invoiceId: string, companyId: string, enabled: boolean): boolean | null {
  const [read, setRead] = useState<{ invoiceId: string; imported: boolean } | null>(null)
  const known = read?.invoiceId === invoiceId

  useEffect(() => {
    if (!enabled || known) return
    let cancelled = false
    void createClient()
      .from('migration_source_records')
      .select('id')
      .eq('company_id', companyId)
      .eq('resource', 'salesInvoices')
      .eq('target_id', invoiceId)
      .limit(1)
      .then(({ data, error }) => {
        if (!cancelled) setRead({ invoiceId, imported: !error && (data ?? []).length > 0 })
      })
    return () => {
      cancelled = true
    }
  }, [enabled, known, invoiceId, companyId])

  return known ? read.imported : null
}

interface SendReminderDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  invoiceId: string
  companyId: string
  canWrite: boolean
  /** A reminder went out: the page reads its reminder history again. */
  onSent: () => void
}

/**
 * "Skicka påminnelse" on an overdue invoice (accounted#104, phase 3): the
 * mail at the level the policy picks and who gets it, a warning when the
 * invoice was imported (the old sender reminded imported history that was
 * long paid), then the outcome, including the bank check's retry once the
 * person attests the invoice is unpaid. When the policy would skip the
 * invoice (the next level not due yet, all three sent, an answer from the
 * customer, ...) it says why instead, and offers no send. Renders nothing
 * while REMINDERS_SENDING_ENABLED is false.
 */
export function SendReminderDialog(props: SendReminderDialogProps) {
  if (!REMINDERS_SENDING_ENABLED) return null
  return <SendReminderDialogContent {...props} />
}

function SendReminderDialogContent({ open, onOpenChange, invoiceId, companyId, canWrite, onSent }: SendReminderDialogProps) {
  const t = useTranslations('reminders_setup')
  const tCommon = useTranslations('common')
  const locale = errorLocale(useLocale())
  const preview = useReminderPreview(invoiceId, undefined, open)
  const imported = useInvoiceImported(invoiceId, companyId, open)
  const [results, setResults] = useState<PickedSendResult[] | null>(null)
  const [sendError, setSendError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)

  const mail = preview.result?.ok ? preview.result.data : null
  // What a pick would do now: a skip is said, not sent (the send would skip it too).
  const skip = mail?.decision.kind === 'skip' ? mail.decision.reason : null

  const handleOpenChange = (next: boolean) => {
    if (sending) return
    onOpenChange(next)
    if (!next) {
      setResults(null)
      setSendError(null)
    }
  }

  async function send(bankAttested: boolean) {
    const outcome = await sendPickedReminders(locale, [invoiceId], bankAttested)
    setResults((previous) => (bankAttested && previous ? mergeSendResults(previous, outcome.results) : outcome.results))
    setSendError(outcome.error)
    if (outcome.results.some((result) => result.status === 'sent')) {
      onSent()
      // The next open shows the next level, or why there is none: never this read again.
      preview.retry()
    }
  }

  async function confirm(bankAttested: boolean) {
    setSending(true)
    try {
      await send(bankAttested)
    } finally {
      setSending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent aria-describedby={undefined} className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-display text-lg tracking-tight">{t('invoice_dialog_title')}</DialogTitle>
        </DialogHeader>
        {mail && !results && (
          <p data-ph-mask="" className="text-[13px] leading-relaxed">
            {skip
              ? t(`skip_${skip}`)
              : mail.to
                ? t('invoice_dialog_body', { name: t(`level_name_${mail.level}`), to: mail.to })
                : t('invoice_dialog_no_email')}
          </p>
        )}
        {imported && !results && !skip && <p className="attn text-[12.5px]">{t('invoice_imported_warning')}</p>}
        {results ? (
          <ReminderSendResults results={results} canWrite={canWrite} onAttestedRetry={() => confirm(true)} />
        ) : (
          !skip && <ReminderMailPreview result={preview.result} onRetry={preview.retry} />
        )}
        {sendError && <p className="text-[13px] text-destructive">{sendError}</p>}
        <DialogFooter className="gap-2 sm:gap-2">
          {results ? (
            <Button onClick={() => handleOpenChange(false)}>{t('close')}</Button>
          ) : (
            <>
              <Button variant="ghost" disabled={sending} onClick={() => handleOpenChange(false)}>
                {tCommon('cancel')}
              </Button>
              <Button disabled={!canWrite || !mail?.to || skip !== null} loading={sending} onClick={() => void confirm(false)}>
                {t('invoice_send')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
