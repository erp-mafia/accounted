/**
 * POST /api/v1/companies/{companyId}/k3-transition/commit: the transition voucher
 * (operation k3-transition.commit).
 *
 * Contract, docs and rules live in src/lib/operations/k3.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { k3TransitionCommit } from '@/lib/operations/k3'

export const POST = v1OperationHandler(k3TransitionCommit)
