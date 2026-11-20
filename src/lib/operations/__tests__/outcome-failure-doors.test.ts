import { describe, expect, it, vi } from 'vitest'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { getStructuredError } from '@/lib/errors/get-structured-error'
import { OperationError, throwOutcomeFailure } from '@/lib/operations/errors'
import { v1OutcomeResponse } from '@/lib/operations/v1'
import type { OperationOutcome } from '@/lib/operations/types'

// A failed outcome may keep a published code and speak another registry
// entry's answer (a document on a locked year: PERIOD_LOCKED with
// DOC_UPLOAD_PERIOD_LOCKED's). The v1 door and the thrown door (MCP tools)
// are pinned here; the dashboard door in session-failure-response.test.ts and
// the approval of a staged operation in pending-operations/executors.test.ts.
// A thrown failure carries the Swedish and the next step: its message_en is
// the thrown text, as for every refusal thrown in Swedish.

type Failure = Extract<OperationOutcome<unknown>, { ok: false }>

const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as never
const answer = getErrorEntry('DOC_UPLOAD_PERIOD_LOCKED')!
const registry = getErrorEntry('PERIOD_LOCKED')!

const lockedYear: Failure = {
  ok: false,
  code: 'PERIOD_LOCKED',
  details: { journal_entry_id: 'je-1' },
  messageSv: answer.message_sv,
  messageEn: answer.message_en,
  remediation: answer.remediation,
}

describe('v1OutcomeResponse', () => {
  it('answers the outcome\'s sentences and next step under its code', async () => {
    const res = await v1OutcomeResponse(lockedYear, { requestId: 'req-1', log })
    const { error } = await res.json()
    expect(res.status).toBe(registry.httpStatus)
    expect(error).toMatchObject({
      code: 'PERIOD_LOCKED',
      message: answer.message_sv,
      message_en: answer.message_en,
      recovery_hint: answer.remediation!.description,
      details: { journal_entry_id: 'je-1', reason: answer.message_sv },
    })
  })

  it('keeps a Swedish sentence alone under details.reason, beside the registry message', async () => {
    const res = await v1OutcomeResponse(
      { ok: false, code: 'PERIOD_LOCKED', messageSv: 'Året är låst.' },
      { requestId: 'req-1', log },
    )
    const { error } = await res.json()
    expect(error.message).toBe(registry.message_sv)
    expect(error.message_en).toBe(registry.message_en)
    expect(error.details).toEqual({ reason: 'Året är låst.' })
  })
})

describe('throwOutcomeFailure', () => {
  it('hands an agent the outcome\'s next step, not the registry\'s for the code', () => {
    let thrown: unknown
    try {
      throwOutcomeFailure(lockedYear)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(OperationError)
    const structured = getStructuredError(thrown)
    expect(structured.code).toBe('PERIOD_LOCKED')
    expect(structured.message_sv).toBe(answer.message_sv)
    expect(structured.remediation).toEqual(answer.remediation)
  })

  it('leaves the registry\'s next step for an outcome that brings none', () => {
    const structured = getStructuredError(new OperationError('PERIOD_LOCKED', { messageSv: 'Året är låst.' }))
    expect(structured.remediation).toEqual(registry.remediation)
  })
})
