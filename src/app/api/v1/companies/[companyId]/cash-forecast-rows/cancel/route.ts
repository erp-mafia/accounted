/**
 * POST /api/v1/companies/{companyId}/cash-forecast-rows/cancel (operation cash-forecast-rows.cancel).
 *
 * Contract, docs and rules live in src/lib/operations/cash-forecast.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { cashForecastRowsCancel } from '@/lib/operations/cash-forecast'

export const POST = v1OperationHandler(cashForecastRowsCancel)
