import NewInvoiceEditor from '@/components/invoices/editor/NewInvoiceEditor'
import { parseNewEditorParams } from '@/lib/invoices/editor/new-editor-params'

/**
 * Ny faktura (and offert, proforma, följesedel, självfaktura, copy): the
 * one-screen editor, a full-bleed page (MainContainer) with a URL, a working
 * back button and reload safety. ?type= preselects the document type,
 * ?copy=<id> copies an invoice (lib/invoices/editor/new-editor-params.ts).
 */
export default async function NewInvoicePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { documentType, selfBilled, copyFromId } = parseNewEditorParams(await searchParams)
  return (
    <NewInvoiceEditor
      key={`${copyFromId ?? ''}:${documentType ?? ''}:${selfBilled ? 'self' : ''}`}
      copyFromId={copyFromId}
      selfBilled={selfBilled}
      documentType={documentType}
    />
  )
}
