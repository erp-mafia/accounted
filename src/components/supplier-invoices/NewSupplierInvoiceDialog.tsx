'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogVeil,
  holdEscapeWhileUnsaved,
  useDashShellInert,
  useEditedSinceOpen,
} from '@/components/ui/dialog'
import { SegmentedControl } from '@/components/ui/segmented-control'
import NewSupplierInvoiceForm, { type SettleWithBankRow } from '@/components/supplier-invoices/NewSupplierInvoiceForm'
import { UnderlagPreviewPane } from '@/components/supplier-invoices/UnderlagPreviewPane'
import { cn } from '@/lib/utils'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Invoice-inbox item to convert; prefills the form from its AI extraction. */
  inboxItemId?: string | null
  /** With an inbox item: its underlag, shown beside the form while the invoice is checked. */
  documentId?: string | null
  /** With an inbox item: the bank row that paid it, settled against on registration. */
  settleWith?: SettleWithBankRow | null
  /**
   * Fired after a successful create. Hosts close the dialog and either
   * navigate to the invoice detail (id given) or refresh their list in place.
   */
  onCreated: (invoiceId?: string) => void
  /** With an inbox item: the cost account of what was bought, on every line the reading gives. */
  prefillAccount?: string | null
}

// Width caps at the space left of a docked agent sheet so the form's right
// edge, and the Registrera button, never end up unreachable under the sheet
// (z-60 over z-50). --agent-sheet-w is docked-only, so with the sheet closed
// this is exactly the old sm:max-w-2xl.
const FORM_WIDTH_CLASS = 'sm:max-w-[min(42rem,calc(100vw-var(--agent-sheet-w,0px)))]'

// With an underlag to read, the same cap in one of two widths. --room is the
// space left of a docked sheet. From 74rem of it the cap steps (the clamp is
// a switch: 0 below, the whole difference above) from the form's 42rem to
// the room less a 2rem margin each side, at most 80rem: the form keeps its
// 42rem and the page beside it gets about 27rem or more. Below that (a
// phone, a narrow window, a docked sheet on a laptop) it is the form's own
// cap again and the two take turns. One expression, so no script has to
// watch the window or the sheet; the panes follow the dialog's own width
// (@5xl sits between the two widths), not the viewport.
//
// The dialog stops scrolling as a whole: the title stays, and the form and
// the document each scroll on their own under it.
const WITH_DOCUMENT_CLASS =
  '@container flex flex-col gap-0 overflow-hidden p-0 [--room:calc(100vw_-_var(--agent-sheet-w,0px))] sm:max-w-[min(var(--room),42rem_+_clamp(0rem,(var(--room)_-_74rem)_*_999,min(var(--room)_-_46rem,38rem)))]'

type View = 'form' | 'document'

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
 *
 * The underlag (the inbox item's, or the file dropped into the form) is
 * shown beside the form, because supplier, amounts and accounts are checked
 * against the invoice: a pane of its own where the dialog has the room, one
 * tap away where it has not. Without an underlag the dialog is the form
 * alone, laid out as before.
 */
export default function NewSupplierInvoiceDialog({
  open,
  onOpenChange,
  inboxItemId,
  documentId = null,
  settleWith = null,
  onCreated,
  prefillAccount = null,
}: Props) {
  const t = useTranslations('supplier_invoice_editor')

  // Non-modal dialog (see below): page modality is restored by hand so the
  // agent sheet stays live. See useDashShellInert in components/ui/dialog.tsx.
  useDashShellInert(open)
  const { edited, editProps } = useEditedSinceOpen()

  // Without an inbox item: the file dropped into the form, once it is stored.
  const [uploadedDocumentId, setUploadedDocumentId] = useState<string | null>(null)
  // Which of the two shows while the dialog has room for one. The form stays
  // mounted behind the document, so nothing typed is lost.
  const [view, setView] = useState<View>('form')
  // Each open starts on the form, without the last one's file.
  const [wasOpen, setWasOpen] = useState(open)
  if (wasOpen !== open) {
    setWasOpen(open)
    setView('form')
    setUploadedDocumentId(null)
  }
  const shownDocumentId = documentId ?? uploadedDocumentId

  return (
    <Dialog open={open} onOpenChange={onOpenChange} modal={false}>
      <DialogVeil />
      <DialogContent
        className={shownDocumentId ? WITH_DOCUMENT_CLASS : FORM_WIDTH_CLASS}
        // Non-modal so the docked agent sheet (fixed z-[60], portaled outside
        // this dialog) stays scrollable and typeable while an invoice is being
        // registered: a modal Radix dialog wraps its overlay in RemoveScroll
        // and sets pointer-events: none on <body>, which froze the sheet at
        // whatever scroll position it had when the dialog opened (#2745).
        // Same convention as TransactionBookingDialog and NewInvoiceDialog
        // (which pair non-modality with the inert effect above).
        //
        // Escape closes an untouched dialog, like every other overlay, but a
        // half-typed invoice must survive a stray Escape (nested comboboxes
        // and date pickers portal outside the dialog): then closing is
        // explicit, the header X or Avbryt. The form opens prefilled from an
        // inbox item and keeps the underlag and totals outside its form
        // state, so "changed since open" decides (useEditedSinceOpen). A
        // backdrop click never closes it.
        onEscapeKeyDown={(e) => holdEscapeWhileUnsaved(e, edited())}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader
          // pr-12 clears the corner X for the switch as well as the title.
          className={cn(
            shownDocumentId && 'shrink-0 flex-row flex-wrap items-center justify-between gap-x-4 gap-y-3 py-5 pl-5 pr-12',
          )}
        >
          <DialogTitle>{t('page_title')}</DialogTitle>
          {shownDocumentId && (
            // Outside editProps on purpose: looking at the document is not an
            // edit, so Escape still closes a dialog nobody has typed in.
            <SegmentedControl
              className="@5xl:hidden"
              aria-label={t('underlag_view_label')}
              value={view}
              onChange={setView}
              options={[
                { value: 'form', label: t('underlag_view_form') },
                { value: 'document', label: t('underlag_view_document') },
              ]}
            />
          )}
        </DialogHeader>
        {/* Without an underlag both wrappers are display: contents, so the
            form sits in the dialog as before. With one, the panes take the
            height the dialog has left (h-dvh is asked for and the dialog's
            max height shrinks it), and each scrolls on its own. */}
        <div
          className={
            shownDocumentId
              ? cn(
                  'grid min-h-0 grid-cols-1 grid-rows-[minmax(0,1fr)] @5xl:h-dvh @5xl:grid-cols-[minmax(0,1fr)_42rem]',
                  view === 'document' && 'h-dvh',
                )
              : 'contents'
          }
        >
          {shownDocumentId && (
            <UnderlagPreviewPane
              documentId={shownDocumentId}
              className={cn('mx-5 mb-5 @5xl:mr-0', view === 'form' && 'hidden @5xl:flex')}
            />
          )}
          <div
            className={
              shownDocumentId
                ? cn(
                    // The paddings the dialog itself gives the form without an underlag.
                    'min-h-0 overflow-y-auto px-5 pb-5 scrollbar-visible',
                    view === 'document' && 'hidden @5xl:block',
                  )
                : 'contents'
            }
          >
            <div className="contents" {...editProps}>
              <NewSupplierInvoiceForm
                // A new bank row is a new form: the payer starts from it.
                key={`${inboxItemId ?? 'fresh'}:${settleWith?.transactionId ?? ''}`}
                bare
                inboxItemId={inboxItemId}
                settleWith={settleWith}
                prefillAccount={prefillAccount}
                onCreated={onCreated}
                onCancel={() => onOpenChange(false)}
                onUnderlagDocument={setUploadedDocumentId}
              />
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
