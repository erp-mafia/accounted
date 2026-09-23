/**
 * Pure account-ring selection and weighting for `LedgerGraph`.
 *
 * Lives outside the component (which is `'use client'` and pure JSX) so the
 * rule below can be unit tested: this repo runs Vitest in the `node`
 * environment and never renders components, so logic embedded in a component
 * is unverifiable by construction. Same arrangement as
 * `components/transactions/invoice-candidate-ranking.ts`.
 *
 * # Why this exists
 *
 * The ring weighted each account wedge with:
 *
 *     const spend = items.reduce((s, i) => s + Math.max(i.total_amount, 0), 0)
 *     return spend > 0 ? spend : items.reduce((s, i) => s + i.occurrences, 0)
 *
 * The fallback is per group, but the weights are then summed into one
 * denominator (`shownWeight`) and ranked against each other. So an account
 * whose entities carry no usable amount contributed a booking COUNT (say 4)
 * into a denominator otherwise made of kronor (say 250 000), and:
 *
 *   - its wedge came out ~0.002% of the circle, i.e. an invisible sliver whose
 *     payee nodes all collapse onto one angle, and
 *   - it sorted below every money-weighted account, so it was the first thing
 *     dropped by the top-`maxAccounts` truncation.
 *
 * An account the agent genuinely books to therefore vanished from the map for
 * no reason other than its magnitude being expressed in a different unit.
 * Silent exclusion, which is exactly what this surface must not do.
 *
 * The rule here: the whole ring is measured in ONE unit. Amount if every
 * account has a usable amount, booking volume otherwise. Never a mix. The unit
 * is decided over every account, not just the nine that end up shown, because
 * the unit is what ranks them: deciding it from the survivors would be circular
 * and would reintroduce the truncation bug it exists to prevent. The chosen
 * unit is returned as `basis` so the legend can say which one the sizes
 * actually mean instead of always claiming "Storlek = belopp".
 *
 * # What this does NOT fix
 *
 * `DeepEntity.total_amount` arrives from `get_ledger_deep_context` already
 * summed to a single scalar per entity, built as
 * `abs(coalesce(t.amount_sek, t.amount))` on the counterparty side and
 * `coalesce(si.total_sek, si.total, 0)` on the supplier side. That is SEK when
 * a SEK equivalent was recorded and the RAW FOREIGN AMOUNT otherwise, and the
 * RPC projects neither `currency` nor a per-row breakdown. A 500 EUR supplier
 * invoice with no stored exchange rate therefore reaches this file as the
 * number 500, indistinguishable from 500 kr.
 *
 * Nothing here can undo that: by the time the payload exists the currencies
 * have already been added together upstream, and no field survives that would
 * let us split them, convert them or even count them. Forming a per-currency
 * total on this side would mean inventing one. The fix belongs in the RPC
 * (project `total_amount_sek` + per-currency totals + a count of rows with no
 * SEK equivalent, and drop the raw-foreign fallback); this file is written so
 * that the moment those fields exist, `entityMagnitude` is the single place
 * that has to learn about them.
 */
import type { DeepEntity } from '@/lib/agent-context/ledger-deep'

/** How many account wedges the ring shows before it truncates. */
export const MAX_ACCOUNTS = 9
/** How many payee nodes one wedge shows before it truncates. */
export const MAX_PER_ACCOUNT = 6

/**
 * The unit the whole ring is measured in.
 *
 * - `amount`: `total_amount` as delivered by the RPC (kronor, with the caveat
 *   in the file header). Only chosen when every account has one.
 * - `volume`: number of bookings. Currency-free, so it is always available and
 *   is what the ring falls back to rather than mixing units.
 */
export type RingBasis = 'amount' | 'volume'

export interface RingGroup {
  /** BAS account number. Strings, never numbers (CLAUDE.md). */
  number: string
  /** Entities booked to this account, biggest magnitude first. */
  items: DeepEntity[]
  /**
   * Wedge weight, in `basis` units. Computed over ALL the account's entities,
   * including the ones `items` truncated away, so the wedge keeps the size the
   * account actually earned.
   */
  weight: number
}

export interface RingSelection {
  basis: RingBasis
  /** Shown accounts, ordered by account number so wedges never swap places. */
  groups: RingGroup[]
  /** True when accounts or payees were dropped by the display caps. */
  truncated: boolean
  /** Sum of the shown weights, floored at 1 so it is always a safe divisor. */
  totalWeight: number
  /** Largest single-entity magnitude among the shown groups, floored at 1. */
  maxMagnitude: number
}

/**
 * One entity's magnitude in the ring's unit.
 *
 * `total_amount` is whole kronor (`round(...)::bigint` in the RPC), so summing
 * these is exact integer arithmetic and needs no öre rounding. Negative totals
 * are clamped to 0 rather than subtracted from a sibling: this drives geometry,
 * and a negative radius is not a thing.
 */
export function entityMagnitude(entity: DeepEntity, basis: RingBasis): number {
  if (basis === 'volume') return Math.max(entity.occurrences, 0)
  return Math.max(entity.total_amount, 0)
}

function sumMagnitude(items: DeepEntity[], basis: RingBasis): number {
  return items.reduce((sum, item) => sum + entityMagnitude(item, basis), 0)
}

/**
 * Groups entities by their dominant account and picks what the ring shows.
 *
 * Deterministic end to end: ties break on account number rather than on input
 * order, so the demo lays out identically on every load.
 */
export function selectAccountRing(
  entities: DeepEntity[],
  options: { maxAccounts?: number; maxPerAccount?: number } = {},
): RingSelection {
  const maxAccounts = options.maxAccounts ?? MAX_ACCOUNTS
  const maxPerAccount = options.maxPerAccount ?? MAX_PER_ACCOUNT

  const byAccount = new Map<string, DeepEntity[]>()
  for (const entity of entities) {
    const account = entity.dominant_account_number
    if (!account) continue
    const bucket = byAccount.get(account)
    if (bucket) bucket.push(entity)
    else byAccount.set(account, [entity])
  }

  const buckets = [...byAccount.entries()]

  // The unit decision, made once for the whole ring. An account with no usable
  // amount would otherwise be weighted in bookings while its siblings are
  // weighted in kronor, and the two get summed into one denominator below.
  const basis: RingBasis =
    buckets.length > 0 && buckets.every(([, items]) => sumMagnitude(items, 'amount') > 0)
      ? 'amount'
      : 'volume'

  let groups: RingGroup[] = buckets.map(([number, items]) => ({
    number,
    items: [...items].sort((a, b) => entityMagnitude(b, basis) - entityMagnitude(a, basis)),
    weight: sumMagnitude(items, basis),
  }))

  // Rank to decide what to show, then lay out in account-number order.
  groups.sort((a, b) => b.weight - a.weight || a.number.localeCompare(b.number))
  const accountCount = groups.length
  groups = groups.slice(0, maxAccounts)
  let truncated = accountCount > groups.length
  for (const group of groups) {
    if (group.items.length > maxPerAccount) {
      truncated = true
      group.items = group.items.slice(0, maxPerAccount)
    }
  }
  groups.sort((a, b) => a.number.localeCompare(b.number))

  const totalWeight = groups.reduce((sum, group) => sum + group.weight, 0) || 1
  const maxMagnitude = Math.max(
    ...groups.flatMap((group) => group.items.map((item) => entityMagnitude(item, basis))),
    1,
  )

  return { basis, groups, truncated, totalWeight, maxMagnitude }
}
