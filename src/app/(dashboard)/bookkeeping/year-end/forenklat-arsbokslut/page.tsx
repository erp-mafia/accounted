'use client'

import { Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { ForenklatArsbokslutView } from '@/components/bokslut/ForenklatArsbokslutView'

/**
 * The förenklat årsbokslut (BFNAR 2010:1) of the räkenskapsår in ?period=,
 * reached from the year-end wizard's last step and the report library.
 */
function ForenklatArsbokslutForPeriod() {
  const periodId = useSearchParams().get('period')
  return <ForenklatArsbokslutView key={periodId ?? 'none'} periodId={periodId} />
}

export default function ForenklatArsbokslutPage() {
  return (
    <Suspense fallback={<div className="space-y-8" />}>
      <ForenklatArsbokslutForPeriod />
    </Suspense>
  )
}
