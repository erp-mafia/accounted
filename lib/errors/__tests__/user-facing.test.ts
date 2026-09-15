import { describe, it, expect, vi } from 'vitest'
import { userFacing, userFacingCode } from '../user-facing'
import { errorResponse } from '../get-structured-error'

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

async function envelope(err: unknown) {
  const res = errorResponse(err, log as never, { requestId: 'req-1' })
  return { status: res.status, body: (await res.json()) as { error: { code: string; message: string; message_en: string } } }
}

describe('userFacing', () => {
  it('keeps the sentence the author wrote instead of the registry line', async () => {
    // The real case: a klarmarkerat fiscal year reached the wizard as
    // "Ett oväntat serverfel uppstod. Försök igen senare." and a 500, on a
    // state the user can undo themselves in two clicks.
    const refusal =
      'Räkenskapsåret 2021 är markerat som avslutat i ett tidigare program. ' +
      'Öppna det igen under Inställningar > Bokföring > Räkenskapsår.'
    const { status, body } = await envelope(userFacing(new Error(refusal)))
    expect(body.error.message).toBe(refusal)
    expect(status).toBe(400)
  })

  it('stays Swedish in both locales, like the engine\'s other domain errors', async () => {
    const { body } = await envelope(userFacing(new Error('Välj vad som ska importeras.')))
    expect(body.error.message).toBe('Välj vad som ska importeras.')
    expect(body.error.message_en).toBe('Välj vad som ska importeras.')
  })

  it('lets the caller pick how the failure is classified', async () => {
    const { body } = await envelope(userFacing(new Error('Importen är pausad.'), 'CONFLICT'))
    expect(body.error.code).toBe('CONFLICT')
    expect(body.error.message).toBe('Importen är pausad.')
  })

  it('falls back rather than inventing a code the registry does not know', async () => {
    // A marker is not a licence to invent statuses: an unknown code drops to
    // the ordinary path, which is safe and silent rather than wrong and loud.
    const { status, body } = await envelope(userFacing(new Error('Hittepå.'), 'NOT_A_REAL_CODE'))
    expect(body.error.code).toBe('INTERNAL_ERROR')
    expect(status).toBe(500)
  })

  it('leaves an unmarked error alone, so nothing leaks by default', async () => {
    const { status, body } = await envelope(new Error('connect ECONNREFUSED 127.0.0.1:5432'))
    expect(body.error.message).not.toContain('ECONNREFUSED')
    expect(status).toBe(500)
  })

  it('refuses an empty sentence, which is worse than the canned one', async () => {
    const { body } = await envelope(userFacing(new Error('   ')))
    expect(body.error.message.trim()).not.toBe('')
  })

  it('does not expose the marker to anything that enumerates the error', () => {
    const err = userFacing(new Error('x'))
    expect(Object.keys(err)).toEqual([])
    expect(JSON.stringify({ ...err })).toBe('{}')
    expect(userFacingCode(err)).toBe('VALIDATION_ERROR')
    expect(userFacingCode(new Error('x'))).toBeNull()
  })
})
