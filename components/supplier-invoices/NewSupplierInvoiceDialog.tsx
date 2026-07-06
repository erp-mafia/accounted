'use client'

import { useTranslations } from 'next-intl'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import NewSupplierInvoiceForm from '@/components/supplier-invoices/NewSupplierInvoiceForm'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Invoice-inbox item to convert; prefills the form from its AI extraction. */
  inboxItemId?: string | null
  /**
   * Fired after a successful create. Hosts close the dialog and either
   * navigate to the invoice detail (id given) or refresh their list in place.
   */
  onCreated: (invoiceId?: string) => void
}

/**
 * "Registrera leverantörsfaktura" as a modal: mirrors NewJournalEntryDialog.
 * Wraps the bare NewSupplierInvoiceForm; the form's own review/confirm,
 * supplier-create, bank-picker, and conflict dialogs stack on top of this one.
 */
export default function NewSupplierInvoiceDialog({
  open,
  onOpenChange,
  inboxItemId,
  onCreated,
}: Props) {
  const t = useTranslations('supplier_invoice_editor')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-4xl max-h-[95dvh] sm:max-h-[90vh] overflow-y-auto"
        // A half-typed invoice must survive an accidental backdrop click or a
        // stray Escape (nested comboboxes and date pickers portal outside the
        // dialog). Closing is explicit: the header X or Avbryt. Same
        // convention as NewJournalEntryDialog.
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{t('page_title')}</DialogTitle>
        </DialogHeader>
        <NewSupplierInvoiceForm
          key={inboxItemId ?? 'fresh'}
          bare
          inboxItemId={inboxItemId}
          onCreated={onCreated}
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  )
}
