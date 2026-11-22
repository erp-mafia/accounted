'use client'

import { useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { SupportLink } from '@/components/ui/support-link'
import { StatusGlyph } from '@/components/ui/status-glyph'
import { captureBoundaryError } from '@/lib/analytics/client'

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[dashboard] Unhandled error:', error)
    captureBoundaryError(error, 'dashboard')
  }, [error])

  // Stil v3 states: the error sits in the page, centered where the content
  // would be, with the red glyph, one sentence and "Försök igen".
  return (
    <section role="alert" className="mx-auto flex max-w-[560px] flex-col items-center gap-1 pb-2 pt-10 text-center animate-rise">
      <StatusGlyph tone="error" size={16} className="mb-2" />
      <h2 className="text-[15px] font-medium leading-[22px] text-strong">Något gick fel</h2>
      <p className="text-[13px] text-muted-foreground">
        Ett oväntat fel uppstod. Försök igen eller{' '}
        <SupportLink variant="inline" subject="Oväntat fel" assistant={false}>kontakta support</SupportLink>{' '}
        om problemet kvarstår.
      </p>
      <div className="mt-3">
        <Button variant="outline" size="toolbar" onClick={reset}>
          Försök igen
        </Button>
      </div>
    </section>
  )
}
