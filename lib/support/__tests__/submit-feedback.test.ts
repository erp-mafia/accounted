import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { submitFeedback } from '@/lib/support/submit-feedback'

// posthog-js is browser-only and irrelevant to delivery: stub it so the
// analytics breadcrumb can be asserted without initialising the real SDK.
const captureMock = vi.fn()
const sendMessageMock = vi.fn()
const isAvailableMock = vi.fn(() => true)
vi.mock('posthog-js', () => ({
  default: {
    capture: (...a: unknown[]) => captureMock(...a),
    conversations: {
      isAvailable: () => isAvailableMock(),
      sendMessage: (...a: unknown[]) => sendMessageMock(...a),
    },
  },
}))

describe('submitFeedback', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    captureMock.mockClear()
    sendMessageMock.mockClear()
    isAvailableMock.mockReturnValue(true)
    // Analytics on by default so the breadcrumb path is exercised.
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'false')
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN', 'phc_test')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  function stubFetchOk() {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) })
    vi.stubGlobal('fetch', fetchSpy)
    return fetchSpy
  }

  it('delivers over email and reports the email channel', async () => {
    const fetchSpy = stubFetchOk()

    const result = await submitFeedback({ subject: 'Hjälpsida', message: 'Hjälp tack' })

    expect(result.ok).toBe(true)
    expect(result.channels).toEqual(['email', 'ticket'])
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/support/contact',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ subject: 'Hjälpsida', message: 'Hjälp tack' }),
      })
    )
  })

  // Recapt used to mask a failing email endpoint by reporting success on its
  // own channel. Email is now the only delivery path, so its failure must
  // surface to the user instead of being swallowed.
  it('reports failure when the email endpoint rejects', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({ error: 'Mailtjänsten är inte konfigurerad' }),
      })
    )

    const result = await submitFeedback({ message: 'msg' })

    // A ticket may still open, but delivery failed, so ok stays false.
    expect(result.ok).toBe(false)
    expect(result.channels).not.toContain('email')
    expect(result.error).toBe('Mailtjänsten är inte konfigurerad')
  })

  it('reports failure when fetch itself throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network down')))

    const result = await submitFeedback({ message: 'msg' })

    expect(result.ok).toBe(false)
    expect(result.channels).not.toContain('email')
    expect(result.error).toBe('Network down')
  })

  it('records a PostHog breadcrumb WITHOUT the message body', async () => {
    stubFetchOk()

    await submitFeedback({ subject: 'Hjälpsida', message: 'känslig text om mitt bolag' })

    expect(captureMock).toHaveBeenCalledWith('support_feedback_submitted', {
      subject: 'Hjälpsida',
      attachment_count: 0,
      delivered: true,
      email: 'ok',
      ticket: 'ok',
      lost: false,
    })
    // Free text is user content: it must never ride along as an event property.
    expect(JSON.stringify(captureMock.mock.calls)).not.toContain('känslig text')
  })

  it('marks the breadcrumb undelivered when email failed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }))

    await submitFeedback({ message: 'msg' })

    expect(captureMock).toHaveBeenCalledWith(
      'support_feedback_submitted',
      expect.objectContaining({ delivered: false })
    )
  })

  it('skips the breadcrumb entirely when analytics is off (self-hosted)', async () => {
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
    stubFetchOk()

    const result = await submitFeedback({ message: 'msg' })

    expect(result.ok).toBe(true)
    expect(captureMock).not.toHaveBeenCalled()
  })

  it('does not let a throwing analytics SDK break delivery', async () => {
    captureMock.mockImplementationOnce(() => {
      throw new Error('posthog boom')
    })
    stubFetchOk()

    const result = await submitFeedback({ message: 'msg' })

    expect(result.ok).toBe(true)
    expect(result.channels).toContain('email')
  })

  describe('PostHog Support ticket channel', () => {
    it('opens a ticket carrying the message body, unlike the analytics breadcrumb', async () => {
      stubFetchOk()
      await submitFeedback({ subject: 'Moms', message: 'Jag fastnar på ruta 05' })
      expect(sendMessageMock).toHaveBeenCalledWith('[Moms]\n\nJag fastnar på ruta 05')
    })

    it('omits the subject prefix when there is no subject', async () => {
      stubFetchOk()
      await submitFeedback({ message: 'bara text' })
      expect(sendMessageMock).toHaveBeenCalledWith('bara text')
    })

    // A ticket alone is NOT delivery: nobody is watching PostHog at 02:00, and
    // Recapt masking a dead email endpoint is the exact bug we removed.
    it('does not report success when only the ticket worked', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: 'down' }) }))
      const result = await submitFeedback({ message: 'msg' })
      expect(result.ok).toBe(false)
      expect(result.channels).toEqual(['ticket'])
      expect(result.error).toBe('down')
    })

    it('still delivers by email when conversations are unavailable', async () => {
      isAvailableMock.mockReturnValue(false)
      stubFetchOk()
      const result = await submitFeedback({ message: 'msg' })
      expect(result.ok).toBe(true)
      expect(result.channels).toEqual(['email'])
      expect(sendMessageMock).not.toHaveBeenCalled()
    })

    it('still delivers by email when sendMessage throws', async () => {
      sendMessageMock.mockRejectedValueOnce(new Error('conversations boom'))
      stubFetchOk()
      const result = await submitFeedback({ message: 'msg' })
      expect(result.ok).toBe(true)
      expect(result.channels).toEqual(['email'])
    })

    it('opens no ticket when analytics is off (self-hosted)', async () => {
      vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
      stubFetchOk()
      const result = await submitFeedback({ message: 'msg' })
      expect(result.channels).toEqual(['email'])
      expect(sendMessageMock).not.toHaveBeenCalled()
    })
  })

  describe('breadcrumb channel outcomes', () => {
    it('reports ticket: ok when the ticket opened', async () => {
      stubFetchOk()
      await submitFeedback({ message: 'msg' })
      expect(captureMock).toHaveBeenCalledWith(
        'support_feedback_submitted',
        expect.objectContaining({ ticket: 'ok', lost: false })
      )
    })

    // 'unavailable' is the expected steady state (Support off, analytics off);
    // 'failed' means conversations were live and the call still did not land.
    // Only the second deserves an alert, so they must not collapse.
    it("reports ticket: unavailable when conversations are not available", async () => {
      isAvailableMock.mockReturnValue(false)
      stubFetchOk()
      await submitFeedback({ message: 'msg' })
      expect(captureMock).toHaveBeenCalledWith(
        'support_feedback_submitted',
        expect.objectContaining({ ticket: 'unavailable' })
      )
    })

    it('reports ticket: failed when sendMessage throws', async () => {
      sendMessageMock.mockRejectedValueOnce(new Error('boom'))
      stubFetchOk()
      await submitFeedback({ message: 'msg' })
      expect(captureMock).toHaveBeenCalledWith(
        'support_feedback_submitted',
        expect.objectContaining({ ticket: 'failed' })
      )
    })

    it('reports email: failed but not lost when the ticket still opened', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }))
      await submitFeedback({ message: 'msg' })
      expect(captureMock).toHaveBeenCalledWith(
        'support_feedback_submitted',
        expect.objectContaining({ email: 'failed', ticket: 'ok', lost: false })
      )
    })

    // The alerting signal: the user's message reached nobody at all.
    it('sets lost when email failed and the ticket was unavailable', async () => {
      isAvailableMock.mockReturnValue(false)
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')))
      await submitFeedback({ message: 'msg' })
      expect(captureMock).toHaveBeenCalledWith(
        'support_feedback_submitted',
        expect.objectContaining({ email: 'failed', ticket: 'unavailable', lost: true })
      )
    })

    it('sets lost when email failed and the ticket genuinely errored', async () => {
      sendMessageMock.mockRejectedValueOnce(new Error('boom'))
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')))
      await submitFeedback({ message: 'msg' })
      expect(captureMock).toHaveBeenCalledWith(
        'support_feedback_submitted',
        expect.objectContaining({ email: 'failed', ticket: 'failed', lost: true })
      )
    })

    // A hung sendMessage must not hold the confirmation dialog open: the ticket
    // is capped and reported as 'timeout', while email still decides ok.
    it('does not let a hanging ticket call block the user', async () => {
      vi.useFakeTimers()
      sendMessageMock.mockImplementationOnce(() => new Promise(() => {}))
      stubFetchOk()
      const pending = submitFeedback({ message: 'msg' })
      await vi.advanceTimersByTimeAsync(5000)
      const result = await pending
      vi.useRealTimers()

      expect(result.ok).toBe(true)
      expect(result.channels).toEqual(['email'])
      expect(captureMock).toHaveBeenCalledWith(
        'support_feedback_submitted',
        expect.objectContaining({ email: 'ok', ticket: 'timeout', lost: false })
      )
    })

    it('still carries no message body', async () => {
      stubFetchOk()
      await submitFeedback({ subject: 'Moms', message: 'hemlig fritext om bolaget' })
      expect(JSON.stringify(captureMock.mock.calls)).not.toContain('hemlig fritext')
    })

    it('counts attachments without naming them', async () => {
      stubFetchOk()
      await submitFeedback({
        message: 'Se bilagan',
        files: [new File(['x'], 'kontoutdrag-privat.png', { type: 'image/png' })],
      })
      const props = captureMock.mock.calls[0][1] as Record<string, unknown>
      expect(props.attachment_count).toBe(1)
      expect(JSON.stringify(captureMock.mock.calls)).not.toContain('kontoutdrag-privat')
    })
  })

  describe('attachments', () => {
    it('sends multipart with the files when there are any', async () => {
      const fetchSpy = stubFetchOk()
      const file = new File(['x'], 'skarmbild.png', { type: 'image/png' })

      await submitFeedback({ subject: 'Trasig vy', message: 'Ser ut så här', files: [file] })

      const init = fetchSpy.mock.calls[0][1]
      expect(init.body).toBeInstanceOf(FormData)
      // The browser has to set the multipart boundary itself.
      expect(init.headers).toBeUndefined()
      const form = init.body as FormData
      expect(form.get('subject')).toBe('Trasig vy')
      expect(form.get('message')).toBe('Ser ut så här')
      expect(form.getAll('files')).toHaveLength(1)
      expect((form.get('files') as File).name).toBe('skarmbild.png')
    })

    it('keeps the JSON body when the file list is empty', async () => {
      const fetchSpy = stubFetchOk()

      await submitFeedback({ subject: 'Moms', message: 'Jag fastnar', files: [] })

      expect(fetchSpy.mock.calls[0][1].body).toBe(
        JSON.stringify({ subject: 'Moms', message: 'Jag fastnar' })
      )
    })

    it('surfaces the route error when an attachment is rejected', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          json: async () => ({ error: 'Du kan bifoga max 3 filer' }),
        })
      )

      const result = await submitFeedback({
        message: 'Fyra bilder',
        files: [new File(['x'], 'a.png', { type: 'image/png' })],
      })

      expect(result.ok).toBe(false)
      expect(result.error).toBe('Du kan bifoga max 3 filer')
    })
  })
})
