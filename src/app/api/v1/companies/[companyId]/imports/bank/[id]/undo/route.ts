/**
 * POST /api/v1/companies/{companyId}/imports/bank/{id}/undo: undo a bank file
 * import, deleting only its still-unbooked rows (operation imports.bank.undo).
 *
 * Contract, docs and rules in src/lib/operations/imports.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { importsBankUndo } from '@/lib/operations/imports'

// A full-year file is thousands of rows: same budget as the dashboard undo.
export const maxDuration = 300

export const POST = v1OperationHandler(importsBankUndo)
