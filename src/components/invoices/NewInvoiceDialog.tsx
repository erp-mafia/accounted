'use client'

import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Dialog, DialogContent, DialogTitle, DialogVeil, useDashShellInert } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { createClient } from '@/lib/supabase/client'
import { useCompany } from '@/contexts/CompanyContext'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import {
  buildInvoiceCopyInitial,
  canCopyInvoice,
  type InvoiceCopyInitial,
  type InvoiceCopySource,
} from '@/lib/invoices/copy-invoice'

// The editor (and its framer-motion dependency) is a large chunk that must
// not ship with the invoice LIST bundle. This dialog is itself loaded with
// next/dynamic by app/(dashboard)/invoices/page.tsx, so a static import here
// keeps the editor in the dialog's deferred chunk: ONE chunk download when
// "Ny faktura" opens instead of the dialog chunk followed by a second,
// dependent editor chunk (and then the editor's own data fetches).
import InvoiceEditor from '@/components/invoices/InvoiceEditor'
import type { InvoiceDocumentType } from '@/types'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  copyFromId?: string | null
  /** Preselect the självfaktura tab (split-button entry on /invoices). */
  selfBilled?: boolean
  /** Preselect a document type: 'quote' ("Ny offert") or 'proforma' ("Ny proformafaktura") split-button entries. */
  documentType?: InvoiceDocumentType
}

/**
 * "Ny faktura" as a modal: mirrors NewJournalEntryDialog. Wraps the bare
 * InvoiceEditor; the editor's own review/confirm/send dialogs stack on top of
 * this one, and every successful create navigates to the invoice detail page
 * (unmounting the host list page and this dialog with it).
 *
 * The accessible title is visually hidden: the bare editor renders its own
 * live heading, which tracks document type (faktura/proforma/offert/följesedel)
 * and shows the invoice-number preview: a static DialogTitle would duplicate
 * or contradict it.
 */
export default function NewInvoiceDialog({
  open,
  onOpenChange,
  copyFromId = null,
  selfBilled = false,
  documentType,
}: Props) {
  const t = useTranslations('invoice_editor')
  const { company } = useCompany()
  const supabase = useMemo(() => createClient(), [])
  const [copyLoad, setCopyLoad] = useState<{
    sourceId: string | null
    initial: InvoiceCopyInitial | null
    failed: boolean
  }>({ sourceId: null, initial: null, failed: false })

  useEffect(() => {
    if (!open || !copyFromId) return
    if (!company?.id) return

    let cancelled = false

    const loadCopySource = async () => {
      const { data, error } = await supabase
        .from('invoices')
        .select('*')
        .eq('id', copyFromId)
        .eq('company_id', company.id)
        .single()

      let items: Record<string, unknown>[] = []
      if (!error && data) {
        try {
          // invoice_items has NO company_id column: it is scoped through its
          // parent invoice. Filtering on it made PostgREST answer 42703, which
          // fetchAllRows rethrows, so the copy flow hit the "kunde inte
          // laddas" panel for EVERY company. Tenancy is unaffected: the
          // invoices lookup above already pins copyFromId to this company, and
          // the invoice_items RLS policy joins back to the parent invoice.
          items = await fetchAllRows<Record<string, unknown>>(({ from, to }) =>
            supabase
              .from('invoice_items')
              .select('*')
              .eq('invoice_id', copyFromId)
              .order('id', { ascending: true })
              .range(from, to),
          )
        } catch {
          if (!cancelled) setCopyLoad({ sourceId: copyFromId, initial: null, failed: true })
          return
        }
      }

        if (cancelled) return
        const source = data ? { ...data, items } : null
        if (error || !source || !canCopyInvoice(source)) {
          setCopyLoad({ sourceId: copyFromId, initial: null, failed: true })
          return
        }
        setCopyLoad({
          sourceId: copyFromId,
          initial: buildInvoiceCopyInitial(source as InvoiceCopySource),
          failed: false,
        })
    }

    void loadCopySource()

    return () => {
      cancelled = true
    }
  }, [company?.id, copyFromId, open, supabase])

  const copyInitial = copyLoad.sourceId === copyFromId ? copyLoad.initial : null
  const copyLoadFailed = copyLoad.sourceId === copyFromId && copyLoad.failed

  // Non-modal dialog (see below): page modality is restored by hand so the
  // agent sheet stays live. See useDashShellInert in components/ui/dialog.tsx.
  useDashShellInert(open)

  return (
    <Dialog open={open} onOpenChange={onOpenChange} modal={false}>
      <DialogVeil />
      <DialogContent
        // p-0/gap-0: the bare editor carries its own padding so its sticky
        // action bar can sit flush against the dialog's bottom edge (position
        // sticky binds to this DialogContent, the scroll container).
        className="sm:max-w-2xl max-h-[95dvh] sm:max-h-[90vh] overflow-y-auto p-0 gap-0"
        // A half-typed invoice must survive an accidental backdrop click or a
        // stray Escape (nested comboboxes and date pickers portal outside the
        // dialog). Closing is explicit: the header X. Same convention as
        // NewJournalEntryDialog.
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogTitle className="sr-only">
          {copyFromId
            ? t('title_copy')
            : documentType === 'quote' && !selfBilled
              ? t('title_quote')
              : documentType === 'proforma' && !selfBilled
                ? t('title_proforma')
                : t('title_invoice')}
        </DialogTitle>
        {copyFromId ? (
          copyLoadFailed ? (
            <div className="space-y-4 p-6 text-center">
              <p className="font-medium">{t('copy_load_failed_title')}</p>
              <p className="text-sm text-muted-foreground">{t('copy_load_failed_description')}</p>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t('close')}
              </Button>
            </div>
          ) : copyInitial ? (
            <InvoiceEditor key={copyFromId} mode="copy" initial={copyInitial} bare />
          ) : (
            <div className="space-y-4 p-6">
              <Skeleton className="h-8 w-1/3" />
              <Skeleton className="h-32 w-full" />
              <Skeleton className="h-32 w-full" />
            </div>
          )
        ) : (
          <InvoiceEditor
            mode="create"
            bare
            initialSelfBilled={selfBilled}
            initialDocumentType={documentType}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
