/**
 * PATCH /api/v1/companies/{companyId}/recurring-invoice-schedules/{id}:
 * change a recurring invoice schedule (recurring-invoice-schedules.update);
 * ?stage=true proposes the change for a person to approve instead.
 *
 * Contract, docs and rules live in src/lib/operations/recurring-invoice-schedules.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { recurringInvoiceSchedulesUpdate } from '@/lib/operations/recurring-invoice-schedules'

export const PATCH = v1OperationHandler(recurringInvoiceSchedulesUpdate)
