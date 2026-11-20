'use client'

import { use } from 'react'
import { CreditNoteEditor } from '@/components/invoices/editor/CreditNoteEditor'
import { useViewerRedirect } from '@/components/ui/viewer-lock'

/**
 * Kreditera: the credit note of an issued invoice, in the editor's two-pane
 * shell (components/invoices/editor/CreditNoteEditor.tsx).
 */
export default function CreateCreditNotePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  // A read-only member gets the invoice, never the credit note editor.
  const canWrite = useViewerRedirect(`/invoices/${id}`)
  if (!canWrite) return null
  return <CreditNoteEditor invoiceId={id} />
}
