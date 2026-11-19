/**
 * The mark on a proposal the system closed because its bank row was booked
 * another way (resolve-handled.ts). Client-safe: the queue's history reads it
 * to say so instead of "Avvisad".
 */
import type { PendingOperation } from '@/types'

/** result_data.reason on the operations closed that way. */
export const HANDLED_ELSEWHERE_REASON = 'already_booked'

export function isHandledElsewhere(operation: Pick<PendingOperation, 'status' | 'result_data'>): boolean {
  const resultData = operation.result_data as { auto_rejected?: boolean; reason?: string } | null
  return operation.status === 'rejected' && resultData?.auto_rejected === true && resultData?.reason === HANDLED_ELSEWHERE_REASON
}
