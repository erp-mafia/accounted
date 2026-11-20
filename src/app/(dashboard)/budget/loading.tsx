import { PageHeader } from '@/components/ui/page-header'
import { Skeleton } from '@/components/ui/skeleton'

export default function BudgetLoading() {
  return (
    <div className="space-y-8">
      <PageHeader title={<Skeleton className="h-4 w-24" />} action={<Skeleton className="h-8 w-44 rounded-md" />} />
      <div className="space-y-4">
        <Skeleton className="h-8 w-80 rounded-md" />
        <Skeleton className="h-64 w-full" />
      </div>
    </div>
  )
}
