'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/components/ui/use-toast'
import { validateOcrReference } from '@/lib/bankgiro/luhn'
import { getErrorMessage } from '@/lib/errors/get-error-message'

/**
 * The OCR number of a supplier invoice not yet paid, added or corrected after
 * it was registered. A bankgiro under hard OCR control takes nothing else: a
 * payment referenced by invoice number is refused (OCR_REF_REQUIRED). The
 * reference is metadata, so PUT /api/supplier-invoices/[id] takes it on any
 * unsettled invoice without touching the verifikat. Mounted per opening, so
 * the field starts from the stored value each time.
 */
export function PaymentReferenceDialog({
  invoiceId,
  current,
  onOpenChange,
  onSaved,
}: {
  invoiceId: string
  current: string | null
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}) {
  const t = useTranslations('supplier_invoice_detail')
  const tCommon = useTranslations('common')
  const { toast } = useToast()
  const [value, setValue] = useState(current ?? '')
  const [saving, setSaving] = useState(false)
  const reference = value.trim()
  // A reference that fails the check digit is still kept, but the payment
  // carries the invoice number instead (resolvePaymentReference): say so.
  const notOcr = reference !== '' && !validateOcrReference(reference.replace(/[\s-]/g, ''))

  async function save() {
    setSaving(true)
    try {
      const res = await fetch(`/api/supplier-invoices/${invoiceId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payment_reference: reference }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        toast({ title: t('ocr_save_failed'), description: getErrorMessage(body, { context: 'supplier_invoice' }), variant: 'destructive' })
        return
      }
      onSaved()
      onOpenChange(false)
    } catch (err) {
      toast({ title: t('ocr_save_failed'), description: getErrorMessage(err, { context: 'supplier_invoice' }), variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (saving ? undefined : onOpenChange(open))}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('ocr_dialog_title')}</DialogTitle>
          <DialogDescription>{t('ocr_dialog_description')}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (reference && !saving) void save()
          }}
        >
          <Label htmlFor="payment-reference">{t('ocr_input_label')}</Label>
          <Input
            id="payment-reference"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            inputMode="numeric"
            autoComplete="off"
            maxLength={40}
            autoFocus
            className="tabular-nums"
            data-ph-mask
          />
          {notOcr && <p className="text-[13px] text-muted-foreground">{t('ocr_not_valid')}</p>}
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {tCommon('cancel')}
          </Button>
          <Button onClick={() => void save()} loading={saving} disabled={!reference || reference === (current ?? '')}>
            {tCommon('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
