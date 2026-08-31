import { DetailPageSkeleton } from '@/components/common/DetailPageSkeleton'

/** Route-level fallback for the customer detail segment: same silhouette the page renders while it fetches. */
export default function Loading() {
  return <DetailPageSkeleton />
}
