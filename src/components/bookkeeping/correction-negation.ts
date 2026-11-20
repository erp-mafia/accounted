/**
 * The Skapa ändringsverifikation form's view of its lines against the
 * verifikat it corrects (crm#1397). Pure, so the dialog and its tests share it.
 */

import { negatesOriginal } from '@/lib/core/bookkeeping/correction-shape'
import type { JournalEntryLine } from '@/types'

export interface CorrectionFormLine {
  account_number: string
  debit_amount: string
  credit_amount: string
  line_description: string
}

type OriginalLine = Pick<
  JournalEntryLine,
  'account_number' | 'debit_amount' | 'credit_amount' | 'line_description'
>

/**
 * The form's starting point: the original's own lines, sides as posted. The
 * storno that zeroes the original is posted by the engine, so the user edits
 * what the verifikat should have been, never its reversal.
 */
export function originalToCorrectionLines(originalLines: OriginalLine[]): CorrectionFormLine[] {
  return originalLines.map((line) => ({
    account_number: line.account_number,
    debit_amount: Number(line.debit_amount) > 0 ? String(Number(line.debit_amount)) : '',
    credit_amount: Number(line.credit_amount) > 0 ? String(Number(line.credit_amount)) : '',
    line_description: line.line_description || '',
  }))
}

/**
 * True when the typed lines are the original with debit and credit swapped:
 * the engine's storno already reverses the original, so posting them reverses
 * it a second time (the engine refuses it unless the user says the original
 * itself had the sides swapped). Same verdict as the engine's guard, read
 * before any request so the form can warn while the user is still typing.
 */
export function correctionLinesNegateOriginal(
  lines: CorrectionFormLine[],
  originalLines: OriginalLine[],
): boolean {
  return negatesOriginal(
    lines.map((line) => ({
      account_number: line.account_number,
      debit_amount: parseFloat(line.debit_amount) || 0,
      credit_amount: parseFloat(line.credit_amount) || 0,
    })),
    originalLines,
  )
}
