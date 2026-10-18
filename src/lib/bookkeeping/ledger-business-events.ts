import type { LinkBasisColumns } from '@/lib/links/link-basis'
import { kindForSourceType } from '@/lib/posting/kinds'
import type { BusinessEventDraft } from '@/lib/posting/types'

/**
 * The business events of the ledger's own doors, for the posting port (step
 * 2i): a voucher a person, an agent or an API client writes by hand
 * (ledger.manual, or the kind its source type names), the storno of a posted
 * verifikat (ledger.storno, linked with role reversal) and the corrected
 * verifikat of a rättelse (ledger.correction, role correction), and the
 * sandbox seed's demo verifikat (ledger.system). Pure: built only while
 * POSTING_EVENTS is shadow or strict, never while it is off.
 *
 * No party and no amount: a voucher's rows are the record, the event does
 * not read accounts (an account is never read as a category or a party),
 * and a draft's rows may still change before it is posted. No rule version:
 * a person, an agent or a client wrote the rows, no rule did; a correction
 * whose added rows come from a rule names it (the momsdeklaration's basis
 * fix). Each door hands down its own link basis, resolved in its request
 * (linkBasisColumns, which reads the approval being committed): user_created
 * for a person's own voucher, storno or correction, which a machine
 * credential turns into client_asserted and an approval into
 * agent_proposed_user_approved.
 */

/** The evidence and pending operation of an event from the door's link basis. */
function basisEvidence(linkBasis: LinkBasisColumns | undefined): Pick<BusinessEventDraft, 'evidence' | 'pendingOperationId'> {
  const linkEvidence = linkBasis?.link_evidence ?? null
  return {
    evidence: { link_basis: linkBasis?.link_basis, link_evidence: linkEvidence ?? undefined },
    pendingOperationId: linkEvidence?.pending_operation_id ?? null,
  }
}

/**
 * A voucher written by hand (the dashboard form, the v1 voucher API, the
 * staged create_voucher), dated its verifikat's date. Its kind is the one its
 * source type names, which is ledger.manual unless the door lets the writer
 * label it: the momsredovisning booked from its template (vat.settled), an
 * integration's own business voucher on the v1 API (a webshop order is
 * sale.webshop_order), an IB staged as one (ledger.opening_balance). The
 * event and the read-side projection of the same verifikat then say the
 * same thing. No subject: the verifikat is the door's own record, named by
 * the link.
 */
export function manualVoucherBusinessEvent(args: {
  sourceType?: string | null
  entryDate: string
  linkBasis?: LinkBasisColumns
  /** The inbox item a staged voucher books, and its underlag. */
  inboxItemId?: string | null
  documentId?: string | null
}): BusinessEventDraft {
  const { evidence, pendingOperationId } = basisEvidence(args.linkBasis)
  return {
    kind: kindForSourceType(args.sourceType ?? 'manual') ?? 'ledger.manual',
    category: null,
    occurredOn: args.entryDate,
    evidence: {
      inbox_item_id: args.inboxItemId ?? undefined,
      document_id: args.documentId ?? undefined,
      ...evidence,
    },
    pendingOperationId,
    mappingVersion: null,
    jurisdiction: 'SE',
  }
}

/**
 * The storno of a posted verifikat (kind ledger.storno, linked with role
 * reversal), dated the day it is made, as every storno event: the subject is
 * the verifikat reversed. No amount and no rule version: a storno mirrors its
 * original's lines.
 */
export function voucherStornoBusinessEvent(args: {
  entryId: string
  occurredOn: string
  linkBasis?: LinkBasisColumns
}): BusinessEventDraft {
  return {
    kind: 'ledger.storno',
    category: null,
    occurredOn: args.occurredOn,
    subject: { type: 'journal_entry', id: args.entryId },
    ...basisEvidence(args.linkBasis),
    mappingVersion: null,
    jurisdiction: 'SE',
  }
}

/**
 * The corrected verifikat of a rättelse (kind ledger.correction, linked with
 * role correction), dated the day it is made like its storno: the subject is
 * the verifikat corrected, so the storno and the correction of one rättelse
 * name the same original. A move to another date is a correction too (the
 * same lines on the new date).
 */
export function voucherCorrectionBusinessEvent(args: {
  entryId: string
  occurredOn: string
  linkBasis?: LinkBasisColumns
  /** The rule that produced the added rows, when one did (the basis fix). */
  mappingVersion?: string | null
}): BusinessEventDraft {
  return {
    kind: 'ledger.correction',
    category: null,
    occurredOn: args.occurredOn,
    subject: { type: 'journal_entry', id: args.entryId },
    ...basisEvidence(args.linkBasis),
    mappingVersion: args.mappingVersion ?? null,
    jurisdiction: 'SE',
  }
}

/**
 * The two events of one rättelse, for postingPort.correctJournalEntry: each
 * built only while the port is on, from the door's link basis resolved at
 * that moment.
 */
export function correctionBusinessEvents(args: {
  entryId: string
  occurredOn: () => string
  linkBasis: () => LinkBasisColumns | undefined
  mappingVersion?: () => string | null
}): { stornoEvent: () => BusinessEventDraft; correctionEvent: () => BusinessEventDraft } {
  return {
    stornoEvent: () => voucherStornoBusinessEvent({ entryId: args.entryId, occurredOn: args.occurredOn(), linkBasis: args.linkBasis() }),
    correctionEvent: () =>
      voucherCorrectionBusinessEvent({
        entryId: args.entryId,
        occurredOn: args.occurredOn(),
        linkBasis: args.linkBasis(),
        mappingVersion: args.mappingVersion?.() ?? null,
      }),
  }
}

/**
 * A verifikat the sandbox seed books for an anonymous visitor's demo company
 * (kind ledger.system, whatever its source type), dated its verifikat's date:
 * nobody did the business act, the seed made it up, so system_derived. No
 * subject, party or amount.
 */
export function sandboxSeedBusinessEvent(args: { entryDate: string; linkBasis: LinkBasisColumns }): BusinessEventDraft {
  return {
    kind: 'ledger.system',
    category: null,
    occurredOn: args.entryDate,
    ...basisEvidence(args.linkBasis),
    mappingVersion: null,
    jurisdiction: 'SE',
  }
}

