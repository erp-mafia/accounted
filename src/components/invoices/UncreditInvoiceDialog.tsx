'use client'

import { useEffect, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { formatDate } from '@/lib/utils'

/** What the dry run of POST /api/invoices/[id]/uncredit answers. */
interface UncreditPreview {
  changed: boolean
  credit_note_number: string | null
  attestation_required: boolean
  posts_storno: boolean
  credit_voucher: string | null
  storno_date: string | null
  restored_status: 'sent' | 'partially_paid' | 'paid'
}

type View =
  | { kind: 'loading' }
  | { kind: 'preview'; preview: UncreditPreview }
  | { kind: 'refused'; code: string | null; reason: string | null; message: string }

/** Refusals whose way out is a new invoice made as a copy of the original. */
const COPY_CODES = new Set(['INVOICE_UNCREDIT_DELIVERED', 'INVOICE_UNCREDIT_NOT_REVERSIBLE'])
const NOT_REVERSIBLE_REASONS = new Set(['accrual_schedules', 'customer_loss', 'credit_note_state'])

interface UncreditInvoiceDialogProps {
  invoice: { id: string; invoice_number: string | null }
  /** The editor prefilled from this invoice (Kopiera faktura). */
  copyHref: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onUncredited: () => void | Promise<void>
}

/**
 * "Ångra kreditering" on a credited customer invoice. The dry run says what
 * the server will do before anything is written (convention 10): the storno
 * of the credit note's verifikat, the credit note kept as Ångrad, the status
 * the invoice gets back. A credit note marked as sent asks the person to
 * attest that it never reached the customer; one that did is refused, and
 * the dialog offers a copy of the invoice instead. The rules are the
 * server's (lib/invoices/uncredit-invoice.ts).
 */
export default function UncreditInvoiceDialog({
  invoice,
  copyHref,
  open,
  onOpenChange,
  onUncredited,
}: UncreditInvoiceDialogProps) {
  const t = useTranslations('invoice_detail')
  const tInvoices = useTranslations('invoices')
  const tCommon = useTranslations('common')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const [view, setView] = useState<View>({ kind: 'loading' })
  const [attested, setAttested] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setView({ kind: 'loading' })
    setAttested(false)
    void (async () => {
      try {
        const response = await fetch(`/api/invoices/${invoice.id}/uncredit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dry_run: true }),
        })
        const body = await response.json()
        if (cancelled) return
        if (!response.ok) {
          const error = (body as { error?: { code?: string; details?: { reason?: string } } }).error
          setView({
            kind: 'refused',
            code: error?.code ?? null,
            reason: error?.details?.reason ?? null,
            message: getErrorMessage(body, { context: 'invoice', locale }),
          })
          return
        }
        setView({ kind: 'preview', preview: (body as { data: UncreditPreview }).data })
      } catch (error) {
        if (cancelled) return
        setView({ kind: 'refused', code: null, reason: null, message: getErrorMessage(error, { context: 'invoice', locale }) })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, invoice.id, locale])

  const number = invoice.invoice_number ?? ''

  async function confirm() {
    if (view.kind !== 'preview' || submitting) return
    setSubmitting(true)
    try {
      const response = await fetch(`/api/invoices/${invoice.id}/uncredit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attest_not_delivered: view.preview.attestation_required ? attested : undefined }),
      })
      const body = await response.json()
      if (!response.ok) {
        toast({
          title: t('uncredit_failed_title'),
          description: getErrorMessage(body, { context: 'invoice', locale }),
          variant: 'destructive',
        })
        return
      }
      toast({
        title: t('uncredit_success_title'),
        description: t('uncredit_success_description', {
          number,
          credit: view.preview.credit_note_number ?? '',
        }),
      })
      onOpenChange(false)
      await onUncredited()
    } catch (error) {
      toast({
        title: t('uncredit_failed_title'),
        description: getErrorMessage(error, { context: 'invoice', locale }),
        variant: 'destructive',
      })
    } finally {
      setSubmitting(false)
    }
  }

  let body: ReactNode
  let footer: ReactNode
  if (view.kind === 'loading') {
    body = <p className="text-sm text-muted-foreground">{t('uncredit_loading')}</p>
    footer = (
      <Button variant="outline" onClick={() => onOpenChange(false)}>
        {tCommon('cancel')}
      </Button>
    )
  } else if (view.kind === 'refused') {
    const message =
      view.code === 'INVOICE_UNCREDIT_NOT_REVERSIBLE' && view.reason && NOT_REVERSIBLE_REASONS.has(view.reason)
        ? t(`uncredit_not_reversible_${view.reason}`)
        : view.message
    body = <p className="text-sm">{message}</p>
    footer = (
      <>
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          {tCommon('close')}
        </Button>
        {view.code && COPY_CODES.has(view.code) && (
          <Button asChild>
            <Link href={copyHref}>{t('copy_invoice')}</Link>
          </Button>
        )}
      </>
    )
  } else if (!view.preview.changed) {
    body = <p className="text-sm">{t('uncredit_not_credited')}</p>
    footer = (
      <Button variant="outline" onClick={() => onOpenChange(false)}>
        {tCommon('close')}
      </Button>
    )
  } else {
    const { preview } = view
    const values = {
      credit: preview.credit_note_number ?? '',
      number,
      status: tInvoices(`status_${preview.restored_status}`),
    }
    body = (
      <div className="space-y-4">
        <p className="text-sm">
          {preview.posts_storno
            ? t('uncredit_description_storno', {
                ...values,
                voucher: preview.credit_voucher ?? '',
                date: preview.storno_date ? formatDate(preview.storno_date) : '',
              })
            : t('uncredit_description_no_storno', values)}
        </p>
        {preview.attestation_required && (
          <label htmlFor="uncredit-attest" className="flex cursor-pointer items-start gap-3">
            <Checkbox
              id="uncredit-attest"
              className="mt-0.5"
              checked={attested}
              disabled={submitting}
              onCheckedChange={(value) => setAttested(value === true)}
            />
            <span className="text-sm">
              <span className="block">{t('uncredit_attest_label', { credit: values.credit })}</span>
              <span className="block text-xs leading-snug text-muted-foreground">{t('uncredit_attest_hint')}</span>
            </span>
          </label>
        )}
      </div>
    )
    footer = (
      <>
        <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
          {tCommon('cancel')}
        </Button>
        <Button
          onClick={() => void confirm()}
          disabled={preview.attestation_required && !attested}
          loading={submitting}
        >
          {t('uncredit_confirm')}
        </Button>
      </>
    )
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !submitting && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('uncredit_title', { number })}</DialogTitle>
          <DialogDescription>{t('uncredit_intro')}</DialogDescription>
        </DialogHeader>
        {body}
        <DialogFooter>{footer}</DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
