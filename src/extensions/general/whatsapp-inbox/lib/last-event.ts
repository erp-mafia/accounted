/**
 * Compact, content-free summary of the most recent inbound message on a
 * phone link, for the settings panel (issue #1552): when we last heard from
 * this number and what happened to that message. Derives a closed enum from
 * processing_status + error_message so no internal error text reaches the
 * client; the panel translates the enum through i18n.
 */

export type LastInboundEventKind =
  | 'filed' // done with an inbox item: the receipt landed in Underlag
  | 'handled' // done without an item: command/answer/link code handled
  | 'processing' // received or claimed, still in flight
  | 'awaiting_company' // parked behind the open company question
  | 'duplicate' // same file already exists in the company's Underlag
  | 'rate_limited' // company intake quota declined the file
  | 'unsupported' // media type outside the chat allowlist
  | 'muted' // dropped because the sender paused the channel (stopp)
  | 'declined' // other deliberate silence (stale tap, ignorable type)
  | 'failed' // processing error (the M18 path)

export interface LastInboundEventRow {
  processing_status: string
  error_message: string | null
  inbox_item_id: string | null
}

// error_message markers written by index.ts / process-inbound.ts /
// conversation.ts. Matched by prefix where the writer appends detail.
import { COMPANY_CHOICE_EXPIRED, STAGED_AWAITING_COMPANY } from './conversation'

export function summarizeInboundEvent(row: LastInboundEventRow): LastInboundEventKind {
  switch (row.processing_status) {
    case 'done':
      return row.inbox_item_id ? 'filed' : 'handled'
    case 'received':
    case 'processing':
      return 'processing'
    case 'skipped': {
      const reason = row.error_message ?? ''
      if (reason === STAGED_AWAITING_COMPANY) return 'awaiting_company'
      if (reason === COMPANY_CHOICE_EXPIRED) return 'failed'
      if (reason.startsWith('Duplicate document')) return 'duplicate'
      if (reason === 'Rate limited') return 'rate_limited'
      if (reason.startsWith('Unsupported media type')) return 'unsupported'
      if (reason.startsWith('Muted')) return 'muted'
      return 'declined'
    }
    default:
      return 'failed'
  }
}
