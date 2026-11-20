/**
 * GET /api/v1/companies/{companyId}/k10/{year}: the K10 underlag per
 * delägare for an inkomstår (operation k10.get).
 *
 * Contract, docs and rules live in src/lib/operations/bolaget-owner-tax.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { k10Get } from '@/lib/operations/bolaget-owner-tax'

export const GET = v1OperationHandler(k10Get)
