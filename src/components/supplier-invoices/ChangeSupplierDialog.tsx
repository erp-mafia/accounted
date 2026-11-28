'use client'

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { useToast } from '@/components/ui/use-toast'
import CustomerCombobox from '@/components/customers/CustomerCombobox'
import { useSuppliers } from '@/lib/reference-data/hooks'
import { getErrorMessage } from '@/lib/errors/get-error-message'

/**
 * Byt leverantör: an unpaid, unattested invoice registered on the wrong
 * supplier moves to the right one (POST /api/supplier-invoices/[id]/change-supplier,
 * rules in lib/supplier-invoices/change-supplier.ts). A booked invoice gets
 * its verifikat's text corrected in the same verifikat; the dialog says so
 * before the click, and the server's refusal (attested, another kind of
 * supplier, a locked period) is shown as it is. Mounted per opening.
 */
export function ChangeSupplierDialog({
  invoiceId,
  currentSupplierId,
  booked,
  onOpenChange,
  onChanged,
}: {
  invoiceId: string
  currentSupplierId: string
  /** The invoice has a posted registration verifikat. */
  booked: boolean
  onOpenChange: (open: boolean) => void
  onChanged: () => void
}) {
  const t = useTranslations('supplier_invoice_detail')
  const tCommon = useTranslations('common')
  const { toast } = useToast()
  const { suppliers, isLoading } = useSuppliers()
  const [supplierId, setSupplierId] = useState('')
  const [saving, setSaving] = useState(false)
  // The invoice's own supplier is no choice (the list holds no archived one).
  const choices = useMemo(() => suppliers.filter((s) => s.id !== currentSupplierId), [suppliers, currentSupplierId])

  async function save() {
    setSaving(true)
    try {
      const res = await fetch(`/api/supplier-invoices/${invoiceId}/change-supplier`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ supplier_id: supplierId }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        toast({
          title: t('change_supplier_failed'),
          description: getErrorMessage(body, { statusCode: res.status, context: 'supplier_invoice' }),
          variant: 'destructive',
        })
        return
      }
      toast({ title: t('change_supplier_success') })
      onChanged()
      onOpenChange(false)
    } catch (err) {
      toast({ title: t('change_supplier_failed'), description: getErrorMessage(err, { context: 'supplier_invoice' }), variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (saving ? undefined : onOpenChange(open))}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('change_supplier_title')}</DialogTitle>
          <DialogDescription>{t('change_supplier_description')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="change-supplier">{t('change_supplier_label')}</Label>
          <CustomerCombobox
            kind="supplier"
            id="change-supplier"
            value={supplierId}
            customers={choices}
            onChange={setSupplierId}
            loading={isLoading}
            disabled={saving}
          />
          {booked && <p className="text-[13px] text-muted-foreground">{t('change_supplier_booked_note')}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {tCommon('cancel')}
          </Button>
          <Button onClick={() => void save()} loading={saving} disabled={!supplierId}>
            {t('change_supplier_confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
