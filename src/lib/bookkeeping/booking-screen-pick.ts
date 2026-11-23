/**
 * The proposal a person picked for a bank row outside the booking screen
 * (Bankrader's picker: a template or a counterpart), handed to the screen,
 * which opens with it used. The address says only that a pick waits
 * (`vald=1`, booking-screen.ts); the proposal rides in sessionStorage, keyed
 * by the bank row and taken once, as the skattekonto prefill does
 * (lib/skatteverket/manual-verifikat-prefill.ts). It holds the template's
 * names and accounts, no amounts: the screen asks the server for the lines.
 */
import type { BookingProposal } from './proposal'

const STORAGE_KEY = 'accounted.booking-screen-pick'

/** Minimal Storage surface, injectable so node-env tests can fake it. */
export interface PickStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function defaultStorage(): PickStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage
  } catch {
    // Safe to ignore: sessionStorage throws in some privacy modes, and then
    // there is no handover; the screen opens with its own suggestion.
    return null
  }
}

/** Hand the picked proposal to the booking screen opened next for this bank row. */
export function stagePickedProposal(
  transactionId: string,
  proposal: BookingProposal,
  storage: PickStorage | null = defaultStorage(),
): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify({ transactionId, proposal }))
  } catch {
    // Quota or privacy mode: the screen opens with its own suggestion instead.
  }
}

/** What each kind of booking a proposal makes needs, as the preview reads it (proposal.ts ProposalBooking). */
function isBooking(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const b = value as Record<string, unknown>
  switch (b.kind) {
    case 'template':
      return typeof b.template_id === 'string' && typeof b.category === 'string'
    case 'counterparty':
      return typeof b.counterparty_template_id === 'string'
    case 'account':
      return typeof b.account === 'string' && typeof b.vat_treatment === 'string' && typeof b.category === 'string'
    default:
      return false
  }
}

function isProposal(value: unknown): value is BookingProposal {
  if (!value || typeof value !== 'object') return false
  const p = value as Partial<BookingProposal>
  return typeof p.template_id === 'string' && typeof p.name_sv === 'string' && isBooking(p.booking)
}

/**
 * The proposal picked for this bank row, taken once: read and removed. One
 * staged for another row, or not a proposal, is nothing.
 */
export function takePickedProposal(transactionId: string, storage: PickStorage | null = defaultStorage()): BookingProposal | null {
  if (!storage) return null
  let raw: string | null = null
  try {
    raw = storage.getItem(STORAGE_KEY)
    storage.removeItem(STORAGE_KEY)
  } catch {
    // Safe to ignore: unreadable storage is no pick; the screen opens with its own suggestion.
    return null
  }
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { transactionId?: unknown; proposal?: unknown }
    if (parsed.transactionId !== transactionId || !isProposal(parsed.proposal)) return null
    return parsed.proposal
  } catch {
    // Safe to ignore: a value that is not JSON is no pick (nothing else writes this key).
    return null
  }
}
