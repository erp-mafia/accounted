/**
 * PUT /api/v1/companies/{companyId}/k10/{year}/owners/{partyId}: save what
 * a delägare enters for the K10 underlag of a year (operation k10-inputs.set).
 *
 * Contract, docs and rules live in src/lib/operations/bolaget-owner-tax.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { k10InputsSet } from '@/lib/operations/bolaget-owner-tax'

export const PUT = v1OperationHandler(k10InputsSet)
