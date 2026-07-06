'use client'

import dynamic from 'next/dynamic'
import { useTranslations } from 'next-intl'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'

// Deferred: the editor (and its framer-motion dependency) is a large chunk
// that would otherwise ship with the invoice LIST bundle — it's only needed
// once this dialog actually opens.
const InvoiceEditor = dynamic(() => import('@/components/invoices/InvoiceEditor'), {
  ssr: false,
  loading: () => (
    <div className="space-y-4 p-6">
      <Skeleton className="h-8 w-1/3" />
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-32 w-full" />
    </div>
  ),
})

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * "Ny faktura" as a modal: mirrors NewJournalEntryDialog. Wraps the bare
 * InvoiceEditor; the editor's own review/confirm/send dialogs stack on top of
 * this one, and every successful create navigates to the invoice detail page
 * (unmounting the host list page and this dialog with it).
 *
 * The accessible title is visually hidden: the bare editor renders its own
 * live heading, which tracks document type (faktura/proforma/följesedel) and
 * shows the invoice-number preview: a static DialogTitle would duplicate or
 * contradict it.
 */
export default function NewInvoiceDialog({ open, onOpenChange }: Props) {
  const t = useTranslations('invoice_editor')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-5xl max-h-[95dvh] sm:max-h-[90vh] overflow-y-auto"
        // A half-typed invoice must survive an accidental backdrop click or a
        // stray Escape (nested comboboxes and date pickers portal outside the
        // dialog). Closing is explicit: the header X. Same convention as
        // NewJournalEntryDialog.
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogTitle className="sr-only">{t('title_invoice')}</DialogTitle>
        <InvoiceEditor mode="create" bare />
      </DialogContent>
    </Dialog>
  )
}
