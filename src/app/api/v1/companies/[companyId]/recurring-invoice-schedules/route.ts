/**
 * GET  /api/v1/companies/{companyId}/recurring-invoice-schedules: the
 *      company's recurring invoice schedules (recurring-invoice-schedules.list).
 * POST /api/v1/companies/{companyId}/recurring-invoice-schedules: create one
 *      (recurring-invoice-schedules.create); ?stage=true proposes it for a
 *      person to approve instead.
 *
 * Contract, docs and rules live in src/lib/operations/recurring-invoice-schedules.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import {
  recurringInvoiceSchedulesCreate,
  recurringInvoiceSchedulesList,
} from '@/lib/operations/recurring-invoice-schedules'

export const GET = v1OperationHandler(recurringInvoiceSchedulesList)
export const POST = v1OperationHandler(recurringInvoiceSchedulesCreate)
