import { describe, expect, it, vi } from 'vitest'
import { PACED_UPLOAD_MAX_WAIT_SEC, pacedUploadWaitSec, sendPacedUpload } from '../upload-pacing'

function refusal(retryAfter: string | null, date?: string): Response {
  const headers = new Headers()
  if (retryAfter !== null) headers.set('Retry-After', retryAfter)
  if (date) headers.set('Date', date)
  return new Response(JSON.stringify({ error: { code: 'RATE_LIMITED' } }), { status: 429, headers })
}

const ok = () => new Response(JSON.stringify({ data: { inbox_item_id: 'item-1' } }), { status: 200 })

describe('pacedUploadWaitSec', () => {
  it('is null for a response that is not a rate-limit refusal', () => {
    expect(pacedUploadWaitSec(ok())).toBeNull()
    expect(pacedUploadWaitSec(new Response('{}', { status: 413 }))).toBeNull()
  })

  it('is null for the daily limit, which asks for an hour', () => {
    expect(pacedUploadWaitSec(refusal('3600'))).toBeNull()
  })

  it('is null without a usable Retry-After', () => {
    expect(pacedUploadWaitSec(refusal(null))).toBeNull()
    expect(pacedUploadWaitSec(refusal('soon'))).toBeNull()
    expect(pacedUploadWaitSec(refusal('0'))).toBeNull()
  })

  it('waits the full Retry-After when the server sent no Date', () => {
    expect(pacedUploadWaitSec(refusal('60'))).toBe(60)
    expect(pacedUploadWaitSec(refusal(String(PACED_UPLOAD_MAX_WAIT_SEC)))).toBe(PACED_UPLOAD_MAX_WAIT_SEC)
  })

  it('waits only until the server minute ends, plus a margin', () => {
    // 45 seconds into the minute: 15 seconds left, 2 seconds margin.
    expect(pacedUploadWaitSec(refusal('60', 'Mon, 09 Nov 2026 09:21:45 GMT'))).toBe(17)
    // First second of the minute: capped at Retry-After.
    expect(pacedUploadWaitSec(refusal('60', 'Mon, 09 Nov 2026 09:21:00 GMT'))).toBe(60)
  })
})

describe('sendPacedUpload', () => {
  it('returns the first response when it is not refused, without waiting', async () => {
    const send = vi.fn().mockResolvedValue(ok())
    const sleep = vi.fn().mockResolvedValue(undefined)
    const onWait = vi.fn()

    const res = await sendPacedUpload(send, { sleep, onWait })

    expect(res.status).toBe(200)
    expect(send).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
    expect(onWait).not.toHaveBeenCalled()
  })

  it('waits out a per-minute refusal and sends the same file again', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce(refusal('60', 'Mon, 09 Nov 2026 09:21:45 GMT'))
      .mockResolvedValueOnce(ok())
    const sleep = vi.fn().mockResolvedValue(undefined)
    const onWait = vi.fn()

    const res = await sendPacedUpload(send, { sleep, onWait })

    expect(res.status).toBe(200)
    expect(send).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledWith(17_000)
    expect(onWait.mock.calls).toEqual([[17], [null]])
  })

  it('returns the daily refusal at once', async () => {
    const send = vi.fn().mockResolvedValue(refusal('3600'))
    const sleep = vi.fn().mockResolvedValue(undefined)

    const res = await sendPacedUpload(send, { sleep })

    expect(res.status).toBe(429)
    expect(send).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('gives up after three waits and returns the last refusal', async () => {
    const send = vi.fn().mockImplementation(async () => refusal('60'))
    const sleep = vi.fn().mockResolvedValue(undefined)

    const res = await sendPacedUpload(send, { sleep })

    expect(res.status).toBe(429)
    expect(send).toHaveBeenCalledTimes(4)
    expect(sleep).toHaveBeenCalledTimes(3)
  })

  it('does not send again when the caller has gone away during the wait', async () => {
    const send = vi.fn().mockResolvedValue(refusal('60'))
    const sleep = vi.fn().mockResolvedValue(undefined)

    const res = await sendPacedUpload(send, { sleep, shouldContinue: () => false })

    expect(res.status).toBe(429)
    expect(send).toHaveBeenCalledTimes(1)
    expect(sleep).toHaveBeenCalledTimes(1)
  })

  it('reports the wait as over even when the wait itself fails', async () => {
    const send = vi.fn().mockResolvedValue(refusal('60'))
    const onWait = vi.fn()
    const sleep = vi.fn().mockRejectedValue(new Error('aborted'))

    await expect(sendPacedUpload(send, { sleep, onWait })).rejects.toThrow('aborted')
    expect(onWait.mock.calls).toEqual([[60], [null]])
  })
})
