/**
 * POST /api/v1/companies/{companyId}/dividends/{id}/book: book the dividend
 * decision, D 2098 or 2091 / K 2898 (operation dividends.book).
 *
 * Contract, docs and rules live in src/lib/operations/bolaget-capital.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { dividendsBook } from '@/lib/operations/bolaget-capital'

export const POST = v1OperationHandler(dividendsBook)
