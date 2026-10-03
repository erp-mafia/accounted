'use client'

import { use } from 'react'
import { CreditNoteEditor } from '@/components/invoices/editor/CreditNoteEditor'

/**
 * Kreditera: the credit note of an issued invoice, in the editor's two-pane
 * shell (components/invoices/editor/CreditNoteEditor.tsx).
 */
export default function CreateCreditNotePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  return <CreditNoteEditor invoiceId={id} />
}
