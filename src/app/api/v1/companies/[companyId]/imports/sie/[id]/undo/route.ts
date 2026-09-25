/**
 * POST /api/v1/companies/{companyId}/imports/sie/{id}/undo: queue a batch
 * storno of an SIE import (operation imports.sie.undo).
 *
 * Contract, docs and rules in src/lib/operations/imports.ts.
 */
import { v1OperationHandler } from '@/lib/operations/v1'
import { importsSieUndo } from '@/lib/operations/imports'

// The worker is kicked after the response (next/server after()).
export const maxDuration = 300

export const POST = v1OperationHandler(importsSieUndo)
