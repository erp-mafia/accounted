import { getActor } from '@/lib/bookkeeping/actor-context'
import { committingOperationId } from '@/lib/pending-operations/commit-scope'
import { resolveLinkBasis, type DoorLinkBasis, type LinkBasisColumns, type LinkEvidence } from './link-basis'

/**
 * The link_basis / link_evidence columns a writer spreads into the insert or
 * update that creates a link, resolved against the request it runs in (the
 * pending operation being approved, the commit actor). Server-only: the
 * operation scope is an AsyncLocalStorage (node:async_hooks).
 *
 *   .insert({ ...row, ...linkBasisColumns('user_confirmed') })
 *
 * See ./link-basis.ts for the vocabulary and the resolution rules.
 */
export function linkBasisColumns(door: DoorLinkBasis, evidence?: LinkEvidence): LinkBasisColumns {
  return resolveLinkBasis(door, evidence, {
    pendingOperationId: committingOperationId(),
    actorType: getActor()?.type,
  })
}

/** What a door passes down to a shared writer: its own basis and what it saw. */
export interface LinkBasisInput {
  basis: DoorLinkBasis
  evidence?: LinkEvidence
}

/** linkBasisColumns for a LinkBasisInput handed down by a caller. */
export function linkBasisColumnsFor(input: LinkBasisInput): LinkBasisColumns {
  return linkBasisColumns(input.basis, input.evidence)
}
