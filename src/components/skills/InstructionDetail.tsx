'use client'

import { Suspense } from 'react'
import { AgentDetail } from './AgentDetail'
import { ItemDetail } from './ItemDetail'
import { CreatorProfile } from './CreatorProfile'
import { CreateItem } from './CreateItem'

/** One agent instruction's page (a flow, a knowledge pack or a community item), or a community author's page (av.<handle>). */
export function InstructionDetail({ segment, backHref = '/skills' }: { segment: string; backHref?: string }) {
  const decoded = decodeURIComponent(segment)
  if (decoded.startsWith('av.')) return <CreatorProfile handle={decoded.slice(3)} backHref={backHref} />
  // "Skriv själv": the item page, empty, with fields to fill in (?typ= picks flow, knowledge or analysis).
  if (decoded === 'ny') return <Suspense><CreateItem backHref={backHref} /></Suspense>
  // Suspense: the item pages read ?rutin= (a routine chosen in Skriv själv).
  return decoded.startsWith('kunskap.') || decoded.startsWith('community.') || decoded.startsWith('egen.') || decoded.startsWith('analys.')
    ? <Suspense><ItemDetail segment={decoded} backHref={backHref} /></Suspense>
    : <Suspense><AgentDetail segment={decoded} backHref={backHref} /></Suspense>
}
