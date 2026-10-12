/**
 * Argument checks the hand-written tools run themselves answer
 * VALIDATION_ERROR naming the field. As a plain `throw new Error(text)` they
 * reached the agent as UNKNOWN_ERROR, "Något gick fel. Försök igen.": retry
 * advice for a call that cannot succeed until an argument changes. The English
 * sentence is the one the tool always threw, so an agent reading message_en
 * sees no change.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events'
import { tools } from '../server'
import { toToolError } from '../tool-result'

const COMPANY_ID = '00000000-0000-4000-8000-000000000001'

function tool(name: string) {
  const found = tools.find((t) => t.name === name)
  if (!found) throw new Error(`tool ${name} not registered`)
  return found
}

async function refusal(name: string, args: Record<string, unknown>) {
  const { supabase } = createQueuedMockSupabase()
  try {
    await tool(name).execute(args, COMPANY_ID, 'user-1', supabase as never)
  } catch (err) {
    return toToolError(err, { toolName: name }).error
  }
  throw new Error(`${name} did not refuse`)
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

describe('hand-checked tool arguments answer VALIDATION_ERROR with the field', () => {
  const cases: Array<{ tool: string; args: Record<string, unknown>; field: string; en: string }> = [
    { tool: 'gnubok_close_period', args: {}, field: 'fiscal_period_id', en: 'fiscal_period_id is required' },
    { tool: 'gnubok_mark_invoice_as_paid', args: {}, field: 'invoice_id', en: 'invoice_id is required' },
    { tool: 'gnubok_forget_fact', args: {}, field: 'id', en: 'id is required' },
    { tool: 'gnubok_remember_fact', args: { content: 'Hyran bokas på 5010', kind: 'rumour' }, field: 'kind', en: 'invalid kind: rumour' },
    { tool: 'gnubok_create_transactions', args: { transactions: [] }, field: 'transactions', en: 'transactions must be a non-empty array.' },
    {
      tool: 'gnubok_create_transactions',
      args: { transactions: [{ date: '45/13/2026', amount: 100, description: 'Swish' }] },
      field: 'transactions.0.date',
      en: 'transactions[0].date must be in YYYY-MM-DD format.',
    },
    // "salary_run_id and employee_id are required" became one check per field.
    { tool: 'gnubok_get_payslip', args: { salary_run_id: 'run-1' }, field: 'employee_id', en: 'employee_id is required' },
    {
      tool: 'gnubok_register_absence',
      args: { employee_id: 'emp-1', from: '2026-03-02', to: '03/06/2026', absence_type: 'sick' },
      field: 'to',
      en: 'from and to must be YYYY-MM-DD',
    },
  ]

  for (const c of cases) {
    it(`${c.tool}: ${c.field}`, async () => {
      const error = await refusal(c.tool, c.args)
      expect(error.code).toBe('VALIDATION_ERROR')
      expect(error.message_en).toBe(c.en)
      expect(error.message_sv.startsWith(`${c.field}: `)).toBe(true)
      expect(error.retryable).toBe(false)
    })
  }

  it('a missing argument reads as missing in Swedish', async () => {
    const error = await refusal('gnubok_close_period', {})
    expect(error.message_sv).toBe('fiscal_period_id: Obligatoriskt fält saknas.')
  })

  it('a choice between arguments says which, in Swedish', async () => {
    const error = await refusal('gnubok_approve_pending_operation', {})
    expect(error).toMatchObject({
      code: 'VALIDATION_ERROR',
      message_en: 'operation_id or batch_id is required',
      message_sv: 'operation_id: Ange operation_id eller batch_id.',
    })
  })
})

describe('server.ts keeps its argument checks coded', () => {
  // A plain Error naming a missing argument is UNKNOWN_ERROR again. The only
  // ones left sit in the tools step A1b replaces with generated ones
  // (match_batch_allocate, link_transaction_to_journal_entry,
  // bulk_book_transactions, create_supplier_invoice_from_inbox).
  const LEFT_FOR_A1B = 7

  it('has no new plain "x is required" throws', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'server.ts'), 'utf8')
    const plain = source.match(/throw new Error\(['`"][^'`"\n]*\b(?:is|are) required/g) ?? []
    expect(plain.length).toBeLessThanOrEqual(LEFT_FOR_A1B)
  })
})
