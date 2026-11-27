import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EventPayload } from '@/lib/events/types'

type Answer = { data?: unknown; error?: { message: string } | null }

const calls: Array<{ table: string; op: 'select' | 'update'; values?: unknown; filters: Array<[string, unknown]> }> = []
let statusAnswer: Answer = { data: { status: 'reversed' }, error: null }
let updateAnswer: Answer = { error: null }

function builder(table: string) {
  const call: (typeof calls)[number] = { table, op: 'select', filters: [] }
  calls.push(call)
  const chain = {
    select: () => chain,
    update: (values: unknown) => {
      call.op = 'update'
      call.values = values
      return chain
    },
    eq: (column: string, value: unknown) => {
      call.filters.push([column, value])
      return chain
    },
    maybeSingle: async () => statusAnswer,
    then: (resolve: (value: Answer) => unknown) => Promise.resolve(updateAnswer).then(resolve),
  }
  return chain
}

const createClient = vi.fn(() => ({ from: (table: string) => builder(table) }))
vi.mock('@/lib/auth/api-keys', () => ({
  createServiceClientNoCookies: () => createClient(),
}))

import { moveTaxAccountRowsOnCorrection } from '../tax-row-follows-correction'

const payload = {
  original: { id: 'orig-1' },
  storno: { id: 'storno-1' },
  corrected: { id: 'corr-1' },
  userId: 'user-1',
  companyId: 'company-1',
} as unknown as EventPayload<'journal_entry.corrected'>

describe('moveTaxAccountRowsOnCorrection', () => {
  beforeEach(() => {
    calls.length = 0
    statusAnswer = { data: { status: 'reversed' }, error: null }
    updateAnswer = { error: null }
    createClient.mockClear()
  })

  it('moves the rows of the reversed original to the corrected verifikat, company-scoped', async () => {
    await moveTaxAccountRowsOnCorrection(payload)

    const update = calls.find((c) => c.op === 'update')
    expect(update).toMatchObject({ table: 'skattekonto_transactions', values: { journal_entry_id: 'corr-1' } })
    expect(update?.filters).toEqual([
      ['company_id', 'company-1'],
      ['journal_entry_id', 'orig-1'],
    ])
  })

  it('leaves the rows when the original still stands (a storno moved out of a locked year)', async () => {
    statusAnswer = { data: { status: 'posted' }, error: null }

    await moveTaxAccountRowsOnCorrection(payload)

    expect(calls.some((c) => c.op === 'update')).toBe(false)
  })

  it('moves nothing when the original cannot be read', async () => {
    statusAnswer = { data: null, error: { message: 'down' } }

    await moveTaxAccountRowsOnCorrection(payload)

    expect(calls.some((c) => c.op === 'update')).toBe(false)
  })

  it('does not throw when the move fails or the client cannot be made', async () => {
    updateAnswer = { error: { message: 'permission denied' } }
    await expect(moveTaxAccountRowsOnCorrection(payload)).resolves.toBeUndefined()

    createClient.mockImplementationOnce(() => {
      throw new Error('no service key')
    })
    await expect(moveTaxAccountRowsOnCorrection(payload)).resolves.toBeUndefined()
  })
})
