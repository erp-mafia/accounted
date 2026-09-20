'use client'

import { useTranslations } from 'next-intl'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogVeil,
  useDashShellInert,
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
 * "Registrera leverantörsfaktura" as a dialog: mirrors NewInvoiceDialog.
 * Wraps the bare NewSupplierInvoiceForm; the form's own review/confirm,
 * supplier-create, bank-picker, and conflict dialogs stack on top of this one.
 *
 * Those nested dialogs stay plain modal on purpose. Each is a short step
 * (confirm, pick, one small form) that returns to this form, and a modal
 * child over a non-modal parent is the nesting Radix supports: the child's
 * own overlay dims this content, while a second DialogVeil would sit UNDER
 * it at z-40. NewInvoiceDialog's editor sets the same precedent with its
 * review and create-customer dialogs. The sheet is live again the moment
 * the child closes.
 */
export default function NewSupplierInvoiceDialog({
  open,
  onOpenChange,
  inboxItemId,
  onCreated,
}: Props) {
  const t = useTranslations('supplier_invoice_editor')

  // Non-modal dialog (see below): page modality is restored by hand so the
  // agent sheet stays live. See useDashShellInert in components/ui/dialog.tsx.
  useDashShellInert(open)

  return (
    <Dialog open={open} onOpenChange={onOpenChange} modal={false}>
      <DialogVeil />
      <DialogContent
        // Width caps at the space left of a docked agent sheet so the form's
        // right edge, and the Registrera button, never end up unreachable
        // under the sheet (z-60 over z-50). --agent-sheet-w is docked-only, so
        // with the sheet closed this is exactly the old sm:max-w-2xl.
        className="sm:max-w-[min(42rem,calc(100vw-var(--agent-sheet-w,0px)))] max-h-[95dvh] sm:max-h-[90vh] overflow-y-auto"
        // Non-modal so the docked agent sheet (fixed z-[60], portaled outside
        // this dialog) stays scrollable and typeable while an invoice is being
        // registered: a modal Radix dialog wraps its overlay in RemoveScroll
        // and sets pointer-events: none on <body>, which froze the sheet at
        // whatever scroll position it had when the dialog opened (#2745).
        // Same convention as TransactionBookingDialog and NewInvoiceDialog
        // (which pair non-modality with the inert effect above).
        //
        // A half-typed invoice must survive an accidental backdrop click or a
        // stray Escape (nested comboboxes and date pickers portal outside the
        // dialog). Closing is explicit: the header X or Avbryt.
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
