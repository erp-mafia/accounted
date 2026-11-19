/**
 * Where a key credential's approval of a staged operation came from, as the
 * decision receipt records it in its staged-approval policy_version
 * (./operation.ts writes it, the verifikat view and the behandlingshistorik
 * read it). Pure and client-safe.
 *
 *   - mcp_chat: the AI called gnubok_approve_pending_operation itself. The
 *     server never sees the chat, so whether a person asked for it there is
 *     not known: the record says the AI approved.
 *   - mcp_view: a person clicked Godkänn in Accounted's approval view inside
 *     the AI client (gnubok_approve_from_view, an app-only tool the AI cannot
 *     call; extensions/general/mcp-server/view-approval.ts). Attested by that
 *     client, not a first-party session in Accounted.
 * Other doors (the app, REST, a company grant) record none.
 */
export const APPROVAL_DOORS = ['mcp_chat', 'mcp_view'] as const
export type ApprovalDoor = (typeof APPROVAL_DOORS)[number]

/** The door a staged-approval policy_version records; null for any other policy, or one recorded without a door. */
export function approvalDoorOf(policyVersion: string | null | undefined): ApprovalDoor | null {
  if (typeof policyVersion !== 'string' || !policyVersion.startsWith('staged-approval.')) return null
  const door = policyVersion.split(';').find((part) => part.startsWith('door='))?.slice('door='.length) ?? ''
  return (APPROVAL_DOORS as readonly string[]).includes(door) ? (door as ApprovalDoor) : null
}
