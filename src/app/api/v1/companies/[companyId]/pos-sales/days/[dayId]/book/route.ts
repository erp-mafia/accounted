/**
 * POST /api/v1/companies/{companyId}/pos-sales/days/{dayId}/book (operation pos-sales.day-book).
 *
 * Contract, docs and rules live in src/lib/operations/pos-sales.ts.
 */
import { ensureInitialized } from '@/lib/init'
import { v1OperationHandler } from '@/lib/operations/v1'
import { posSalesDayBook } from '@/lib/operations/pos-sales'

// Booking commits through the engine, which emits journal_entry.committed.
ensureInitialized()

export const POST = v1OperationHandler(posSalesDayBook)
