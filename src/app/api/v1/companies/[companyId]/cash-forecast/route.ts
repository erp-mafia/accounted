/**
 * GET /api/v1/companies/{companyId}/cash-forecast (operation cash-forecast.get).
 *
 * Contract, docs and rules live in src/lib/operations/cash-forecast.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { cashForecastGet } from '@/lib/operations/cash-forecast'

export const GET = v1OperationHandler(cashForecastGet)
