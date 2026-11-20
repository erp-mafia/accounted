import type { Transaction } from '@/types'

/**
 * The underlag a decision about a bank row stands on: the document the row
 * pins (transactions.document_id), or null without one. A stored read of the
 * row (lib/agent/categorize/read-shape.ts) and a person's choice in the Bokför
 * review (./review-choice.ts) both stand while the row still pins it; another
 * underlag is a new question. Client-safe and pure.
 */
export function underlagKeyFor(tx: Pick<Transaction, 'document_id'>): string | null {
  return tx.document_id ?? null
}
