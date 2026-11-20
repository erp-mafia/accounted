/**
 * GET /api/v1/companies/{companyId}/ku20/{year}: the KU20 status of an
 * inkomstår (operation ku20.status.get). The file itself is downloaded in
 * Accounted only: it carries personnummer.
 *
 * Contract, docs and rules live in src/lib/operations/bolaget-owner-tax.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { ku20StatusGet } from '@/lib/operations/bolaget-owner-tax'

export const GET = v1OperationHandler(ku20StatusGet)
