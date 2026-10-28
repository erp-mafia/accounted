import { beforeEach, describe, expect, it, vi } from 'vitest'

const service = vi.hoisted(() => ({ isConfigured: vi.fn(), sendEmail: vi.fn() }))
vi.mock('@/lib/email/service', () => ({ getEmailService: async () => service }))
vi.mock('@/lib/email/brand-sender', () => ({
  getSenderForCompany: vi.fn().mockResolvedValue({ fromName: 'Bolaget AB', fromAddress: null, replyTo: 'kontakt@bolaget.se', brand: null }),
}))

import { sendSigningCompletedMail } from '../send-signing-completed'

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() }
const params = {
  companyId: 'company-1',
  companyName: 'Bolaget AB',
  title: 'Hyresavtal',
  completedAt: '2026-10-17T12:05:00.000Z',
  signers: ['Anna Andersson, VD'],
  verifyUrl: 'https://app.accounted.se/verifiera',
  recipients: ['anna@example.se', 'karin@byran.se'],
  pdf: { filename: 'hyresavtal-signerad.pdf', bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]) },
  log: log as never,
}

beforeEach(() => {
  vi.clearAllMocks()
  service.isConfigured.mockReturnValue(true)
  service.sendEmail.mockResolvedValue({ success: true, messageId: 'm-1' })
})

describe('sendSigningCompletedMail', () => {
  it('sends one mail per recipient with the signed PDF attached, from the company\'s brand', async () => {
    expect(await sendSigningCompletedMail(params)).toEqual({ sent: 2 })
    expect(service.sendEmail.mock.calls.map(([o]) => o.to)).toEqual(['anna@example.se', 'karin@byran.se'])
    const [first] = service.sendEmail.mock.calls[0]!
    expect(first).toMatchObject({ fromName: 'Bolaget AB', replyTo: 'kontakt@bolaget.se', subject: '"Hyresavtal" är signerat av alla' })
    expect(first.attachments).toEqual([{ filename: 'hyresavtal-signerad.pdf', content: Buffer.from([0x25, 0x50, 0x44, 0x46]), contentType: 'application/pdf' }])
    // Never an address in the log.
    expect(JSON.stringify(log.info.mock.calls)).not.toContain('@')
  })

  it('counts only what went out, and never throws on a failed send', async () => {
    service.sendEmail.mockResolvedValueOnce({ success: false, error: 'bounced' })
    expect(await sendSigningCompletedMail(params)).toEqual({ sent: 1 })
    expect(log.error).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(log.error.mock.calls)).not.toContain('@')
  })

  it('sends nothing without recipients or a configured mail service', async () => {
    expect(await sendSigningCompletedMail({ ...params, recipients: [] })).toEqual({ sent: 0 })
    service.isConfigured.mockReturnValue(false)
    expect(await sendSigningCompletedMail(params)).toEqual({ sent: 0 })
    expect(service.sendEmail).not.toHaveBeenCalled()
  })
})
