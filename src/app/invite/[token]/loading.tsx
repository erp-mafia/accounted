import { Skeleton } from '@/components/ui/skeleton'
import { StandalonePage, StandaloneStack } from '@/components/standalone/StandalonePage'

/** The invitation while it loads: the standalone frame with the heading, the company lines and the primary. */
export default function InviteLoading() {
  return (
    <StandalonePage busy>
      <Skeleton className="h-7 w-56" />
      <StandaloneStack>
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-11 w-full" />
      </StandaloneStack>
    </StandalonePage>
  )
}
