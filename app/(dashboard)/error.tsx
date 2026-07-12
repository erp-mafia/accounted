'use client'

import { useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { SupportLink } from '@/components/ui/support-link'

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[dashboard] Unhandled error:', error)
  }, [error])

  return (
    <div className="flex flex-col items-center justify-center min-h-[50vh] gap-4">
      <h2 className="text-xl font-semibold">Något gick fel</h2>
      <p className="text-muted-foreground text-sm max-w-md text-center">
        Ett oväntat fel uppstod. Försök igen eller{' '}
        <SupportLink variant="inline" subject="Oväntat fel">kontakta support</SupportLink>{' '}
        om problemet kvarstår.
      </p>
      <Button onClick={reset}>Försök igen</Button>
    </div>
  )
}
