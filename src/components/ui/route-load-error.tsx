'use client'

import { useRouter } from 'next/navigation'
import { LoadError } from '@/components/ui/empty-state'

/**
 * LoadError for a Server Component page: "Försök igen" re-runs the route's
 * server render (router.refresh), since a server page cannot hand
 * LoadError a callback.
 */
export function RouteLoadError({ title, description }: { title?: string; description?: string }) {
  const router = useRouter()
  return <LoadError title={title} description={description} onRetry={() => router.refresh()} />
}
