/**
 * /api/v1/companies/{companyId}/k3-transition: the transition to K3 (kap. 35).
 * GET reads it (k3-transition.get), POST starts it (k3-transition.start),
 * PATCH sets the relief and the note facts (k3-transition.update), DELETE
 * drops an uncommitted one (k3-transition.delete).
 *
 * Contract, docs and rules live in src/lib/operations/k3.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { k3TransitionDelete, k3TransitionGet, k3TransitionStart, k3TransitionUpdate } from '@/lib/operations/k3'

export const GET = v1OperationHandler(k3TransitionGet)
export const POST = v1OperationHandler(k3TransitionStart)
export const PATCH = v1OperationHandler(k3TransitionUpdate)
export const DELETE = v1OperationHandler(k3TransitionDelete)
