import { Skeleton } from '@/components/ui/skeleton'
import { StandalonePage, StandaloneStack } from '@/components/standalone/StandalonePage'

/** The auth pages while they load: the standalone frame with a heading line, two fields and the primary. */
export function AuthPageSkeleton() {
  return (
    <StandalonePage busy>
      <Skeleton className="h-7 w-32" />
      <StandaloneStack>
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-11 w-full" />
      </StandaloneStack>
    </StandalonePage>
  )
}
