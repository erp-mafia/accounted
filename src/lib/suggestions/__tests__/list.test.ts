import { describe, expect, it } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import { listOpenSuggestions, MAX_OPEN_SUGGESTIONS } from '../list'

const COMPANY = 'c0000000-0000-4000-8000-000000000001'

const suggestion = (id: string, op: string | null, detector = 'first-employee') => ({
  id,
  suggestion_key: `enable_package:${id}`,
  detector,
  pending_operation_id: op,
  created_at: '2026-10-16T10:00:00.000Z',
})

const operation = (id: string, packageId: string) => ({
  id,
  operation_type: 'enable_package',
  title: `Slå på ${packageId}?`,
  preview_data: { package: packageId, reason: `Varför ${packageId}.` },
  params: { package_id: packageId, source: 'suggestion' },
})

describe('listOpenSuggestions', () => {
  it('shows at most three, in the stored rank order, each with a pending operation', async () => {
    const mock = createTableMockSupabase({
      company_suggestions: {
        data: [suggestion('a', 'op-a'), suggestion('b', 'op-b'), suggestion('gone', null), suggestion('c', 'op-c'), suggestion('d', 'op-d'), suggestion('e', 'op-e')],
      },
      // op-b was answered meanwhile: not pending, so not returned.
      pending_operations: { data: [operation('op-a', 'payroll'), operation('op-c', 'assets'), operation('op-d', 'bank'), operation('op-e', 'expenses')] },
    })
    const open = await listOpenSuggestions(mock.supabase as never, COMPANY)
    expect(MAX_OPEN_SUGGESTIONS).toBe(3)
    expect(open.map((s) => s.suggestion_id)).toEqual(['a', 'c', 'd'])
    expect(open[0]).toEqual({
      suggestion_id: 'a',
      pending_operation_id: 'op-a',
      detector: 'first-employee',
      suggestion_key: 'enable_package:a',
      operation_type: 'enable_package',
      package_id: 'payroll',
      title: 'Slå på payroll?',
      reason: 'Varför payroll.',
      created_at: '2026-10-16T10:00:00.000Z',
    })
    expect(mock.findCalls('company_suggestions', 'eq')).toEqual([['company_id', COMPANY], ['state', 'open']])
    expect(mock.findCalls('company_suggestions', 'order')).toEqual([
      ['rank', { ascending: false }],
      ['created_at', { ascending: true }],
    ])
    expect(mock.findCalls('pending_operations', 'eq')).toEqual([['company_id', COMPANY], ['status', 'pending']])
  })

  it('is empty, never an error, when the table cannot be read (a database without it yet)', async () => {
    const mock = createTableMockSupabase({ company_suggestions: { error: { code: '42P01', message: 'relation does not exist' } } })
    expect(await listOpenSuggestions(mock.supabase as never, COMPANY)).toEqual([])
  })

  it('reads no operations when nothing is open', async () => {
    const mock = createTableMockSupabase({ company_suggestions: { data: [] } })
    expect(await listOpenSuggestions(mock.supabase as never, COMPANY)).toEqual([])
    expect(mock.tables()).toEqual(['company_suggestions'])
  })
})
