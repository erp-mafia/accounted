import type { SupabaseClient } from '@supabase/supabase-js'
import { readInboxPairings, type ListedItem } from '@/lib/operations/inbox-pairings'

/**
 * The open inbox items that ride on another one and wait for nobody: a
 * receipt that came with its invoice as one purchase, and an open half whose
 * other half is booked already (lib/operations/inbox-pairings.ts). The Att
 * göra inbox count leaves them out, as the Inkorg's Behöver dig does. Server
 * only: it reads the items' deliveries. Throws on a failed read.
 */
export function inboxCompanionIds(supabase: SupabaseClient, companyId: string) {
  return async (rows: readonly Record<string, unknown>[]): Promise<ReadonlySet<string>> => {
    const pairings = await readInboxPairings(supabase, companyId, rows as unknown as ListedItem[], { readDeliveries: true })
    return new Set([...pairings].filter(([, pairing]) => pairing.role === 'receipt' || pairing.role === 'booked_companion').map(([id]) => id))
  }
}
