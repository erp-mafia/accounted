import { InvoiceEditorSkeleton } from '@/components/common/DetailPageSkeleton'

/** Route-level fallback for the credit-note segment: the editor's own silhouette. */
export default function Loading() {
  return <InvoiceEditorSkeleton />
}
