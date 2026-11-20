/**
 * The spot check before "Godkänn alla": which few proposals the approver is
 * asked to look at, and why each was picked. The reasons are a closed list
 * (a warning, the largest amount, a raised risk level, picked at random), so
 * the page never needs a sentence written for one proposal.
 *
 * Pure: the same proposals give the same sample on the server render, on
 * hydration and after a refetch (the random pick is a hash of the ids, not
 * Math.random).
 */

import { isMoneyField } from './preview-facts'

export const SPOT_CHECK_SIZE = 4

export type SpotCheckReason = 'warning' | 'largest' | 'raised_risk' | 'random'

export interface SpotCheckSource {
  id: string
  risk_level?: string | null
  preview_data?: unknown
  params?: Record<string, unknown> | null
}

/**
 * The amount a proposal is about, as far as its staged fields say: the first
 * numeric money field of the preview, else of the params. Absolute value;
 * null when it names no amount.
 */
export function spotCheckAmount(op: SpotCheckSource): number | null {
  for (const source of [op.preview_data, op.params]) {
    if (!source || typeof source !== 'object') continue
    for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value) && isMoneyField(key)) return Math.abs(value)
    }
  }
  return null
}

/** A stable number per id (FNV-1a), for the random pick. */
function hashOf(id: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * Up to `size` proposals to look at before the rest are approved: one that
 * carries a warning, the one with the largest amount, one with a raised risk
 * level, and the rest picked at random. `hasWarning` says whether a proposal
 * carries a staged compliance warning (vocabulary.complianceWarningOf).
 */
export function pickSpotCheck<T extends SpotCheckSource>(
  proposals: readonly T[],
  hasWarning: (op: T) => boolean,
  size = SPOT_CHECK_SIZE,
): Array<{ op: T; reason: SpotCheckReason }> {
  // By id, so the list's sort order never changes which ones are picked.
  const ops = [...proposals].sort((a, b) => a.id.localeCompare(b.id))
  const picked: Array<{ op: T; reason: SpotCheckReason }> = []
  const taken = new Set<string>()
  const take = (op: T | undefined, reason: SpotCheckReason) => {
    if (!op || taken.has(op.id) || picked.length >= size) return
    taken.add(op.id)
    picked.push({ op, reason })
  }

  take(ops.find(hasWarning), 'warning')

  let largest: T | undefined
  let largestAmount = 0
  for (const op of ops) {
    if (taken.has(op.id)) continue
    const amount = spotCheckAmount(op)
    if (amount !== null && amount > largestAmount) {
      largest = op
      largestAmount = amount
    }
  }
  take(largest, 'largest')

  take(ops.find((op) => !taken.has(op.id) && op.risk_level != null && op.risk_level !== 'low'), 'raised_risk')

  const rest = ops.filter((op) => !taken.has(op.id)).sort((a, b) => hashOf(a.id) - hashOf(b.id) || a.id.localeCompare(b.id))
  for (const op of rest) take(op, 'random')

  return picked
}
