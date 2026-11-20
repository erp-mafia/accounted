/**
 * What a person or an agent is told when the bank rate-limits a consent.
 * The cooldown itself lives in sync-lease.ts; the wording is the one every
 * bank sync door uses (lib/bank-sync/sync-hold-message.ts).
 */

export { rateLimitMessages, retryAfterSeconds } from '@/lib/bank-sync/sync-hold-message'
