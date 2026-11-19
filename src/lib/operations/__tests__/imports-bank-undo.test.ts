/**
 * imports.bank.undo named by one of its transactions (crm#1528): an agent
 * lists transactions, never bank file imports, so the MCP tool takes a
 * transaction_id, resolves the import it came from, and stages the undo
 * pinned to that import id.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { importsBankUndo } from '@/lib/operations/imports'
import { undoBankImport } from '@/lib/import/bank-file/undo-operation'
import type { OperationContext } from '@/lib/operations/types'
import { createTableMockSupabase } from '@/tests/helpers'

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const IMPORT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const TX_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const OWNER = { data: { company_id: COMPANY_ID, role: 'owner' }, error: null }

type Mock = ReturnType<typeof createTableMockSupabase>
const makeClient = (byTable: Parameters<typeof createTableMockSupabase>[0]) => createTableMockSupabase(byTable)

const ctxWith = (client: Mock): OperationContext => ({
  supabase: client.supabase as unknown as SupabaseClient,
  companyId: COMPANY_ID,
  userId: 'user-1',
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as OperationContext['log'],
})

describe('imports.bank.undo input', () => {
  const parse = (v: unknown) => importsBankUndo.input.safeParse(v).success

  it('takes the import id or one transaction id, exactly one of them', () => {
    expect(parse({ bank_file_import_id: IMPORT_ID })).toBe(true)
    expect(parse({ transaction_id: TX_ID })).toBe(true)
    expect(parse({ bank_file_import_id: IMPORT_ID, transaction_id: TX_ID })).toBe(false)
    expect(parse({})).toBe(false)
    expect(parse({ transaction_id: 'nope' })).toBe(false)
  })

  it('stages the undo pinned to the import the dry run resolved', () => {
    const pin = importsBankUndo.mcp!.stage!.pinParams!
    const staged = pin({ transaction_id: TX_ID }, { bank_file_import_id: IMPORT_ID, would_delete_transactions: 3 })
    expect(staged).toEqual({ bank_file_import_id: IMPORT_ID })
    expect(importsBankUndo.input.safeParse(staged).success).toBe(true)
  })
})

describe('undoBankImport by transaction id', () => {
  it('resolves the import from the transaction and previews its undo', async () => {
    const client = makeClient({
      company_members: OWNER,
      bank_file_imports: { data: { id: IMPORT_ID, status: 'completed' }, error: null },
      transactions: [
        { data: { bank_file_import_id: IMPORT_ID }, error: null },
        { data: [{ id: TX_ID, journal_entry_id: null, invoice_id: null, supplier_invoice_id: null }], error: null },
      ],
      invoice_payments: { data: [], error: null },
      supplier_invoice_payments: { data: [], error: null },
      transaction_voucher_links: { data: [], error: null },
      payment_match_log: { data: [], error: null },
    })

    const outcome = await undoBankImport(ctxWith(client), { transactionId: TX_ID }, { dryRun: true })

    expect(outcome).toMatchObject({
      ok: true,
      dryRun: true,
      preview: { bank_file_import_id: IMPORT_ID, would_delete_transactions: 1, skipped_booked: 0 },
    })
    const lookup = client.findCalls('transactions', 'eq')
    expect(lookup).toContainEqual(['id', TX_ID])
    expect(lookup).toContainEqual(['company_id', COMPANY_ID])
    expect(client.supabase.rpc).not.toHaveBeenCalled()
  })

  it('runs the undo RPC on the resolved import', async () => {
    const client = makeClient({
      company_members: OWNER,
      bank_file_imports: { data: { id: IMPORT_ID, status: 'completed' }, error: null },
      transactions: { data: { bank_file_import_id: IMPORT_ID }, error: null },
      'rpc:undo_bank_file_import': { data: { deleted: 5, skipped_booked: 1, skipped_match_history: 0 }, error: null },
    })

    const outcome = await undoBankImport(ctxWith(client), { transactionId: TX_ID })

    expect(outcome).toEqual({
      ok: true,
      data: { bank_file_import_id: IMPORT_ID, deleted_transactions: 5, skipped_booked: 1, skipped_match_history: 0 },
    })
  })

  it('404s a transaction that did not come from a bank file import, deleting nothing', async () => {
    const client = makeClient({ company_members: OWNER, transactions: { data: { bank_file_import_id: null }, error: null } })

    const outcome = await undoBankImport(ctxWith(client), { transactionId: TX_ID })

    expect(outcome).toMatchObject({
      ok: false,
      code: 'BANK_FILE_UNDO_NOT_FOUND',
      details: { transaction_id: TX_ID, reason: 'The transaction did not come from a bank file import.' },
    })
    expect(client.supabase.rpc).not.toHaveBeenCalled()
  })

  it('404s a transaction id outside the company', async () => {
    const client = makeClient({ company_members: OWNER, transactions: { data: null, error: null } })

    const outcome = await undoBankImport(ctxWith(client), { transactionId: TX_ID })

    expect(outcome).toMatchObject({ ok: false, code: 'BANK_FILE_UNDO_NOT_FOUND' })
    expect(client.tables()).not.toContain('bank_file_imports')
  })
})
