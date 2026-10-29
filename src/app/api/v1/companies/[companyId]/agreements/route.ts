/**
 * GET /api/v1/companies/{companyId}/agreements: the company's agreements with
 * the next expected payment and the notice and end dates (operation
 * agreements.list).
 * POST: register an agreement by hand (operation agreements.create).
 *
 * Contract, docs and rules live in src/lib/operations/commitments.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { agreementsCreate, agreementsList } from '@/lib/operations/commitments'

export const GET = v1OperationHandler(agreementsList)
export const POST = v1OperationHandler(agreementsCreate)
