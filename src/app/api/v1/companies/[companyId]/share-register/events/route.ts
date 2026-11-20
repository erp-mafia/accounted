/**
 * GET /api/v1/companies/{companyId}/share-register/events: every aktiebok
 * entry in entry order (operation share-register.events.list).
 * POST: add an entry (operation share-register.events.create);
 * ?dry_run=true previews the holdings before and after.
 *
 * Contract, docs and rules live in src/lib/operations/bolaget.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { shareRegisterEventsCreate, shareRegisterEventsList } from '@/lib/operations/bolaget'

export const GET = v1OperationHandler(shareRegisterEventsList)
export const POST = v1OperationHandler(shareRegisterEventsCreate)
