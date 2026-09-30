/**
 * POST /api/v1/companies/{companyId}/imports/skattekonto-file: import a
 * skattekontoutdrag file sent as base64 (operation imports.skattekonto-file).
 *
 * Contract, docs and rules in src/lib/operations/skattekonto-file.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { importsSkattekontoFile } from '@/lib/operations/skattekonto-file'

export const POST = v1OperationHandler(importsSkattekontoFile)
