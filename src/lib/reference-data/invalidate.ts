/**
 * Invalidate cached reference data after a client-side write.
 *
 * Call this from the success path of any dialog or page that creates,
 * updates or deletes a period, account, cash account, setting, dimension,
 * booking template, customer, supplier or article, so every picker mounted
 * anywhere refetches immediately (SWR's global mutate bypasses the dedupe
 * window). Client-only: it imports the SWR cache.
 */

import { mutate } from 'swr'
import { isReferenceKey, type ReferenceKind } from './keys'

export function invalidateReferenceData(kind: ReferenceKind | ReferenceKind[]): Promise<unknown> {
  const kinds = new Set(Array.isArray(kind) ? kind : [kind])
  return mutate((key) => isReferenceKey(key) && kinds.has(key[0]))
}
