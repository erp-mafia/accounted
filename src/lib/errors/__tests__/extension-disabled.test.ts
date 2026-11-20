/**
 * EXTENSION_DISABLED is raised for several opt-in features (bank sync, the
 * Inkorg's partner door, Skatteverket), so its registry copy names none of
 * them. It used to say "Skatteverket-integrationen är inte aktiverad", which
 * a bank-sync or Inkorg caller was then told. A raiser that knows the
 * feature says so in details (and the Skatteverket extension in its own
 * Swedish message, which passes through).
 */
import { describe, expect, it } from 'vitest'
import { getErrorEntry } from '../structured-errors'
import { getErrorMessage } from '../get-error-message'

describe('EXTENSION_DISABLED', () => {
  it('has generic copy in both languages and stays a 503', () => {
    const entry = getErrorEntry('EXTENSION_DISABLED')
    expect(entry).toMatchObject({
      httpStatus: 503,
      message_sv: 'Funktionen är inte aktiverad i den här installationen.',
      message_en: 'This feature is not enabled on this installation.',
    })
    expect(`${entry?.message_sv} ${entry?.message_en}`).not.toMatch(/skatteverket/i)
  })

  it('lets a raiser\'s own Swedish message through, and falls back to the generic copy otherwise', () => {
    // The response envelope a client reads ({ error: { code, message } }).
    expect(
      getErrorMessage({ error: { code: 'EXTENSION_DISABLED', message: 'Skatteverket-integrationen är inte aktiverad i denna miljö.' } }),
    ).toBe('Skatteverket-integrationen är inte aktiverad i denna miljö.')
    expect(getErrorMessage({ error: { code: 'EXTENSION_DISABLED', message: 'extension not registered' } })).toBe(
      'Funktionen är inte aktiverad i den här installationen.',
    )
  })
})
