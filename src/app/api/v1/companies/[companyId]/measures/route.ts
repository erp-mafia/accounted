/**
 * GET /api/v1/companies/{companyId}/measures: the defined measures, with
 * their definitions, parameters and the report each equals (operation
 * measures.list, src/lib/operations/measures.ts; registry in lib/measures).
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { measuresList } from '@/lib/operations/measures'

export const GET = v1OperationHandler(measuresList)
