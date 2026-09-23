import { describe, it, expect, afterEach, vi } from 'vitest'
import { failureDescription, type ActionFailure } from '@/lib/browser/action-failure'
import { downloadFile } from '@/lib/browser/download-file'
import { postAction } from '@/lib/browser/post-action'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

const COPY = {
  timeout: 'Servern svarade inte i tid. Ingen betalfil sparades. Försök igen.',
  network: 'Ingen kontakt med servern. Ingen betalfil sparades. Kontrollera din internetanslutning och försök igen.',
}

describe('failureDescription', () => {
  it('names a timeout as a timeout', () => {
    expect(failureDescription({ ok: false, reason: 'timeout' }, COPY)).toBe(COPY.timeout)
  })

  it('names a network failure as a network failure', () => {
    // The union's own message for this arm is the generic "Något gick fel",
    // which cannot be told apart from a server error. The caller's copy can.
    const failure: ActionFailure = {
      ok: false,
      reason: 'network',
      message: 'Något gick fel. Försök igen.',
    }
    expect(failureDescription(failure, COPY)).toBe(COPY.network)
    expect(failureDescription(failure, COPY)).not.toBe(COPY.timeout)
  })

  it("keeps the server's own reason, which is more specific than any panel copy", () => {
    const failure: ActionFailure = {
      ok: false,
      reason: 'server',
      status: 400,
      message: 'Bankgironummer saknas i företagsinställningar. Krävs för Bankgirot LB-fil.',
    }
    expect(failureDescription(failure, COPY)).toBe(
      'Bankgironummer saknas i företagsinställningar. Krävs för Bankgirot LB-fil.',
    )
  })

  it('gives the three reasons three different sentences', () => {
    const said = new Set([
      failureDescription({ ok: false, reason: 'timeout' }, COPY),
      failureDescription({ ok: false, reason: 'network', message: 'x' }, COPY),
      failureDescription({ ok: false, reason: 'server', status: 500, message: 'Serverfel' }, COPY),
    ])
    expect(said.size).toBe(3)
  })
})

describe('failure arms of downloadFile and postAction are interchangeable', () => {
  // The panels feed both into one failureDescription call. If either union
  // drifts, this stops compiling, which is the point.
  it('accepts a downloadFile failure', async () => {
    globalThis.fetch = (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch
    const result = await downloadFile({ url: '/x', filename: 'f.txt', saveBlob: () => {} })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(failureDescription(result, COPY)).toBe(COPY.network)
  })

  it('accepts a postAction failure', async () => {
    globalThis.fetch = (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch
    const result = await postAction({ url: '/x' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(failureDescription(result, COPY)).toBe(COPY.network)
  })

  it('still surfaces the salary route 400 verbatim, as the old inline handler did', async () => {
    // The dominant real failure on the payment-file panels: the run is approved
    // but company settings are incomplete. The route answers a plain-string
    // envelope, not the structured one, and that sentence is the whole point of
    // the toast: it names the field the user has to go and fill in. It must
    // survive the move from the inline getErrorMessage call into downloadFile.
    const message = 'Bankgironummer saknas i företagsinställningar. Krävs för Bankgirot LB-fil.'
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: message }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }),
      )) as typeof fetch
    const saveBlob = vi.fn()

    const result = await downloadFile({ url: '/x', filename: 'lon_2026-04.txt', saveBlob })

    expect(saveBlob).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(failureDescription(result, COPY)).toBe(message)
  })
})
