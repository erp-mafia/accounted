import { InvoiceEditorShellSkeleton } from '@/components/invoices/editor/InvoiceEditorShellSkeleton'

/** Route-level fallback for the new-invoice segment: the editor's own silhouette. */
export default function Loading() {
  return <InvoiceEditorShellSkeleton />
}
