/**
 * GET /api/v1/companies/{companyId}/ku31/{year}: the KU31 status of an
 * inkomstår (operation ku31.status.get). The file itself is downloaded in
 * Accounted only: it carries personnummer.
 *
 * Contract, docs and rules live in src/lib/operations/bolaget-capital.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { ku31StatusGet } from '@/lib/operations/bolaget-capital'

export const GET = v1OperationHandler(ku31StatusGet)
