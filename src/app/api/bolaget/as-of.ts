import { isSaneDateString } from '@/lib/invariants/iso-date'

/** The ?as_of= of a Bolaget read: undefined when absent, null when malformed. */
export function readAsOf(request: Request): string | undefined | null {
  const raw = new URL(request.url).searchParams.get('as_of')
  if (raw === null || raw === '') return undefined
  return isSaneDateString(raw) ? raw : null
}
