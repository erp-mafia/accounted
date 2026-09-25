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
    sendMessageMock.mockReset()
    sendMessageMock.mockResolvedValue({ ticket_id: 't1' })
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

  it('delivers a plain message as a PostHog ticket and sends no email', async () => {
    const fetchSpy = stubFetchOk()

    const result = await submitFeedback({ subject: 'Hjälpsida', message: 'Hjälp tack' })

    expect(result).toEqual({ ok: true, channels: ['ticket'] })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('delivers over email when conversations are unavailable', async () => {
    isAvailableMock.mockReturnValue(false)
    const fetchSpy = stubFetchOk()

    const result = await submitFeedback({ subject: 'Hjälpsida', message: 'Hjälp tack' })

    expect(result).toEqual({ ok: true, channels: ['email'] })
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/support/contact',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ subject: 'Hjälpsida', message: 'Hjälp tack' }),
      })
    )
  })

  // Recapt used to mask a failing email endpoint by reporting success on its
  // own channel. When the ticket also failed, the email failure must surface
  // to the user instead of being swallowed.
  it('reports failure when the ticket failed and the email endpoint rejects', async () => {
    sendMessageMock.mockResolvedValue(null)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({ error: 'Mailtjänsten är inte konfigurerad' }),
      })
    )

    const result = await submitFeedback({ message: 'msg' })

    expect(result.ok).toBe(false)
    expect(result.channels).toEqual([])
    expect(result.error).toBe('Mailtjänsten är inte konfigurerad')
  })

  it('reports failure when the ticket failed and fetch itself throws', async () => {
    sendMessageMock.mockResolvedValue(null)
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
      delivered: true,
      email: 'skipped',
      ticket: 'ok',
      lost: false,
    })
    // Free text is user content: it must never ride along as an event property.
    expect(JSON.stringify(captureMock.mock.calls)).not.toContain('känslig text')
  })

  it('marks the breadcrumb undelivered when both channels failed', async () => {
    sendMessageMock.mockResolvedValue(null)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }))

    await submitFeedback({ message: 'msg' })

    expect(captureMock).toHaveBeenCalledWith(
      'support_feedback_submitted',
      expect.objectContaining({ delivered: false, email: 'failed', ticket: 'failed', lost: true })
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
    expect(result.channels).toContain('ticket')
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

    // A customer with an open ticket who starts a new request must get a
    // separate ticket, not another message in the open one.
    it('forces a new ticket when asked to', async () => {
      stubFetchOk()
      await submitFeedback({ message: 'ett nytt ärende', newTicket: true })
      expect(sendMessageMock).toHaveBeenCalledWith('ett nytt ärende', undefined, true)
    })

    // Since 2026-09-14 the founders answer in PostHog and the reply shows in
    // the app, so the ticket IS the delivery; email is not even attempted.
    it('reports success on the ticket alone and leaves email untouched', async () => {
      const fetchSpy = vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: 'down' }) })
      vi.stubGlobal('fetch', fetchSpy)
      const result = await submitFeedback({ message: 'msg' })
      expect(result).toEqual({ ok: true, channels: ['ticket'] })
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('falls back to email when the SDK resolves null', async () => {
      sendMessageMock.mockResolvedValue(null)
      stubFetchOk()
      const result = await submitFeedback({ message: 'msg' })
      expect(result).toEqual({ ok: true, channels: ['email'] })
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

    it('reports email: skipped when the ticket opened', async () => {
      stubFetchOk()
      await submitFeedback({ message: 'msg' })
      expect(captureMock).toHaveBeenCalledWith(
        'support_feedback_submitted',
        expect.objectContaining({ email: 'skipped', ticket: 'ok', lost: false })
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
    // is capped, reported as 'timeout', and email takes over.
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

    it('does not add attachment metadata to analytics', async () => {
      stubFetchOk()
      await submitFeedback({
        message: 'Se bilagan',
        files: [new File(['x'], 'kontoutdrag-privat.png', { type: 'image/png' })],
      })
      const props = captureMock.mock.calls[0][1] as Record<string, unknown>
      expect(props).not.toHaveProperty('attachment_count')
      expect(props).toMatchObject({ email: 'ok', ticket: 'skipped' })
      expect(JSON.stringify(captureMock.mock.calls)).not.toContain('kontoutdrag-privat')
    })
  })

  describe('attachments', () => {
    // Files cannot ride on the conversation API, so a message with files goes
    // by email only, and opens no ticket: the desk makes the ticket from the
    // mail with the files on it, and a second one would be a duplicate.
    it('sends multipart with the files when there are any, and opens no ticket', async () => {
      const fetchSpy = stubFetchOk()
      const file = new File(['x'], 'skarmbild.png', { type: 'image/png' })

      const result = await submitFeedback({ subject: 'Trasig vy', message: 'Ser ut så här', files: [file] })

      expect(result).toEqual({ ok: true, channels: ['email'] })
      expect(sendMessageMock).not.toHaveBeenCalled()
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
      isAvailableMock.mockReturnValue(false)
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
          json: async () => ({ error: 'Du kan bifoga max 5 filer' }),
        })
      )

      const result = await submitFeedback({
        message: 'För många bilder',
        files: [new File(['x'], 'a.png', { type: 'image/png' })],
      })

      expect(result.ok).toBe(false)
      expect(result.error).toBe('Du kan bifoga max 5 filer')
    })
  })
})
