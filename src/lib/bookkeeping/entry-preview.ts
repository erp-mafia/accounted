/**
 * The public preview of a verifikat that a dry run would post: the lines the
 * entry generator builds, before the engine runs. Used by the deferred
 * "Bokför" operations (lib/invoices/book-service.ts,
 * lib/supplier-invoices/book-service.ts), whose dry run and MCP staging
 * preview must show what would be booked without booking it.
 *
 * What the preview does NOT include, stated in `note`: the engine applies the
 * company's account dimension rules (default/fixed values) onto the line bags
 * at commit, and assigns the voucher number atomically in commit_journal_entry.
 */
import { validateBalance } from './engine'
import type { CreateJournalEntryInput } from '@/types'

export interface EntryPreviewLine {
  account_number: string
  debit_amount: number
  credit_amount: number
  line_description: string | null
  dimensions?: Record<string, string> | null
}

export interface EntryPreview {
  fiscal_period_id: string
  entry_date: string
  description: string
  lines: EntryPreviewLine[]
  total_debit: number
  total_credit: number
  balanced: boolean
  note: string
}

export const ENTRY_PREVIEW_NOTE =
  'Lines as the entry generator builds them. At commit the voucher number is assigned and the company\'s account dimension rules may add default dimension values; amounts and accounts do not change.'

export function toEntryPreview(input: CreateJournalEntryInput): EntryPreview {
  const balance = validateBalance(input.lines)
  return {
    fiscal_period_id: input.fiscal_period_id,
    entry_date: input.entry_date,
    description: input.description,
    lines: input.lines.map((line) => ({
      account_number: line.account_number,
      debit_amount: line.debit_amount || 0,
      credit_amount: line.credit_amount || 0,
      line_description: line.line_description ?? null,
      ...(line.dimensions && Object.keys(line.dimensions).length > 0
        ? { dimensions: line.dimensions }
        : {}),
    })),
    total_debit: balance.totalDebit,
    total_credit: balance.totalCredit,
    balanced: balance.valid,
    note: ENTRY_PREVIEW_NOTE,
  }
}
