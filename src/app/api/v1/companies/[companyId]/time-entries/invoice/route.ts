/**
 * /api/v1/companies/{companyId}/time-entries/invoice: a draft invoice from a
 * customer's uninvoiced billable hours.
 *
 * POST : operation time-entries.invoice.
 *
 * Contracts, docs and rules live in src/lib/operations/time-entries.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { timeEntriesInvoice } from '@/lib/operations/time-entries'

export const POST = v1OperationHandler(timeEntriesInvoice)
