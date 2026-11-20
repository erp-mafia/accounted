import { InvoiceEditorShellSkeleton } from '@/components/invoices/editor/InvoiceEditorShellSkeleton'

/** Route-level fallback for the invoice edit segment: the editor's own silhouette. */
export default function Loading() {
  return <InvoiceEditorShellSkeleton />
}
