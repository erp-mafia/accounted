import { Skeleton } from '@/components/ui/skeleton'
import { StandalonePage } from '@/components/standalone/StandalonePage'

/** The payslip link while it loads: the sender row, the heading, the amount, the rows and the primary. */
export default function PayslipLoading() {
  return (
    <StandalonePage width="link" brand={false} busy>
      <Skeleton className="h-7 w-48" />
      <Skeleton className="mt-9 h-7 w-64" />
      <Skeleton className="mt-2 h-7 w-32" />
      <div className="mt-5 space-y-3">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
      </div>
      <Skeleton className="mt-5 h-11 w-full" />
    </StandalonePage>
  )
}
