import { InvoiceEditorShellSkeleton } from '@/components/invoices/editor/InvoiceEditorShellSkeleton'

/** Route-level fallback for the credit page: the editor shell's own silhouette. */
export default function Loading() {
  return <InvoiceEditorShellSkeleton />
}
