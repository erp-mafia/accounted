import { PageHeader } from '@/components/ui/page-header'
import { Skeleton } from '@/components/ui/skeleton'
import { ReviewWalkLoading } from '@/components/pending-operations/ProposalReview'

// The step's own shape while the route loads (convention 17).
export default function Loading() {
  return (
    <div className="space-y-8">
      <PageHeader title={<Skeleton className="h-4 w-40" />} />
      <ReviewWalkLoading />
    </div>
  )
}
