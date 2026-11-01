import { chunk } from '@/lib/utils'

/** What one rattelse-flags request may ask about. The list asks in batches of this size. */
export const RATTELSE_FLAGS_MAX_IDS = 200

export interface RattelseFlags {
  /** The entries with at least one inline rättelse. */
  corrected: Set<string>
  /** A batch failed, so an entry outside `corrected` may still be corrected. */
  incomplete: boolean
}

/**
 * Which of these vouchers carry an inline rättelse, for the "Rättad" marker
 * (BFL 5 kap 5 §: a correction must be easy to become aware of). The voucher
 * list has no upper size ("Visa alla"), the route answers at most
 * RATTELSE_FLAGS_MAX_IDS at a time, so the ids go in batches and the answers
 * are merged. `incomplete` lets the page say a marker may be missing: a
 * corrected voucher that looks untouched is the one wrong answer here.
 */
export async function fetchRattelseFlags(
  entryIds: readonly string[],
  request: (url: string) => Promise<Response> = fetch,
): Promise<RattelseFlags> {
  const answers = await Promise.all(
    chunk(entryIds, RATTELSE_FLAGS_MAX_IDS).map(async (batch): Promise<string[] | null> => {
      try {
        const res = await request(`/api/bookkeeping/journal-entries/rattelse-flags?ids=${batch.join(',')}`)
        if (!res.ok) return null
        const { data } = await res.json()
        return (data ?? []) as string[]
      } catch {
        // Offline or a dropped response: answered as `incomplete`, which the page says out loud.
        return null
      }
    }),
  )
  return {
    corrected: new Set(answers.flatMap((answer) => answer ?? [])),
    incomplete: answers.some((answer) => answer === null),
  }
}
