/**
 * GET  /api/v1/companies/{companyId}/cash-forecast-rows (operation cash-forecast-rows.list)
 * POST /api/v1/companies/{companyId}/cash-forecast-rows (operation cash-forecast-rows.upsert-batch)
 *
 * Contract, docs and rules live in src/lib/operations/cash-forecast.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { cashForecastRowsList, cashForecastRowsUpsertBatch } from '@/lib/operations/cash-forecast'

export const GET = v1OperationHandler(cashForecastRowsList)
export const POST = v1OperationHandler(cashForecastRowsUpsertBatch)
