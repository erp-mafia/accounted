/**
 * Which way a locked årsredovisning version is being signed, as the page
 * reads it from the version's slots and its BankID signing requests. One
 * track per version (./bankid-signing.ts): evidence recorded by hand on any
 * slot keeps the version on that track, and a BankID request that is open,
 * or a slot a BankID signature filled, keeps it on BankID. Pure and
 * client-safe: the page decides from it what to offer, the server still has
 * the last word.
 */
import type { SigningRequestView } from '@/lib/signing/requests'
import type { SignatureRequest } from './signature-service'

export type ArsredovisningSigningTrack =
  /** Nothing signed and nothing open: either way is still open. */
  | { kind: 'none' }
  /** A BankID request is open (`open`), or a BankID signature filled a slot. */
  | { kind: 'bankid'; open: SigningRequestView | null }
  /** A slot carries evidence recorded by hand (paper, another e-signature service). */
  | { kind: 'manual' }

type Slot = Pick<SignatureRequest, 'id' | 'status' | 'signing_method' | 'annual_report_version_id'>

export function deriveArsredovisningSigningTrack(slots: readonly Slot[], requests: readonly SigningRequestView[]): ArsredovisningSigningTrack {
  if (slots.some((s) => s.status === 'signed' && s.signing_method !== 'bankid')) return { kind: 'manual' }
  const open = requests.find((r) => r.state === 'open') ?? null
  if (open || slots.some((s) => s.status === 'signed' && s.signing_method === 'bankid')) return { kind: 'bankid', open }
  return { kind: 'none' }
}

/**
 * Requests that still read as open in the database but are past their
 * expiry: they block a new request for the version (SIGNING_REQUEST_ALREADY_OPEN)
 * until cancelled, so a new sending cancels them first.
 */
export function expiredBlockingRequests(requests: readonly SigningRequestView[]): SigningRequestView[] {
  return requests.filter((r) => r.state === 'expired')
}

/**
 * The signer a new request made for a slot: the one the server answers with
 * that slot's id. Without one (an older answer), the slot's place among the
 * pending slots in roster order is the signer's position, and the name must
 * agree.
 */
export function createdSignerForSlot<S extends { signer_id: string; position: number; name: string; annual_report_signature_id?: string | null }>(
  pendingSlots: readonly Pick<SignatureRequest, 'id' | 'signer_name'>[],
  createdSigners: readonly S[],
  slotId: string,
): S | null {
  const bySlot = createdSigners.find((s) => s.annual_report_signature_id === slotId)
  if (bySlot) return bySlot
  const index = pendingSlots.findIndex((s) => s.id === slotId)
  if (index < 0) return null
  const signer = createdSigners.find((s) => s.position === index + 1) ?? null
  return signer && signer.name === pendingSlots[index]!.signer_name ? signer : null
}
