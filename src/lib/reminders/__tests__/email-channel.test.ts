import { describe, it, expect, vi } from 'vitest'
import type { EmailService } from '@/lib/email/service'
import type { ReminderMessage } from '../channel'
import { createEmailReminderChannel } from '../channels/email'

const MESSAGE: ReminderMessage = {
  companyId: 'company-1',
  to: ['kund@example.se'],
  cc: [],
  bcc: [],
  replyTo: 'faktura@saljaren.se',
  fromName: 'Säljaren AB',
  subject: 'Vänlig påminnelse: Faktura F-1042',
  html: '<p>Hej</p>',
  text: 'Hej',
}

function service(sendEmail: EmailService['sendEmail'], configured = true): EmailService {
  return { sendEmail: vi.fn(sendEmail), isConfigured: () => configured }
}

describe('createEmailReminderChannel', () => {
  it('hands the message and the invoice PDF to the email service', async () => {
    const email = service(async () => ({ success: true, provider: 'resend', messageId: 'msg-1' }))
    const attachments = [{ filename: 'Faktura F-1042.pdf', content: Buffer.from('%PDF'), contentType: 'application/pdf' }]

    expect(await createEmailReminderChannel(email).send({ ...MESSAGE, attachments })).toEqual({ provider: 'resend', providerMessageId: 'msg-1' })
    expect(email.sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: ['kund@example.se'], attachments, cc: undefined }))
  })

  it('sends no attachment field when there is no PDF', async () => {
    const email = service(async () => ({ success: true, provider: 'smtp' }))
    await createEmailReminderChannel(email).send(MESSAGE)
    expect(vi.mocked(email.sendEmail).mock.calls[0]![0]).not.toHaveProperty('attachments')
  })

  it('hands the idempotency key to the email service when there is one', async () => {
    const email = service(async () => ({ success: true, provider: 'resend', messageId: 'msg-1' }))
    await createEmailReminderChannel(email).send({ ...MESSAGE, idempotencyKey: 'reminder-rem-1-1' })
    expect(email.sendEmail).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: 'reminder-rem-1-1' }))
    await createEmailReminderChannel(email).send(MESSAGE)
    expect(vi.mocked(email.sendEmail).mock.calls[1]![0]).not.toHaveProperty('idempotencyKey')
  })

  it('says whether a failure may have gone out', async () => {
    const refused = createEmailReminderChannel(service(async () => ({ success: false, error: 'rejected', outcomeUnknown: false })))
    await expect(refused.send(MESSAGE)).rejects.toMatchObject({ code: 'EMAIL_SEND_FAILED', outcomeUnknown: false })

    // No answer, or a server error after the provider took it (Resend).
    const unknown = createEmailReminderChannel(service(async () => ({ success: false, error: 'Unable to fetch data', outcomeUnknown: true })))
    await expect(unknown.send(MESSAGE)).rejects.toMatchObject({ code: 'EMAIL_SEND_FAILED', outcomeUnknown: true })

    // A service that cannot tell (SMTP) is read as unknown: a retry could remind twice.
    const silent = createEmailReminderChannel(service(async () => ({ success: false, error: 'connection timeout' })))
    await expect(silent.send(MESSAGE)).rejects.toMatchObject({ code: 'EMAIL_SEND_FAILED', outcomeUnknown: true })

    const threw = createEmailReminderChannel(service(async () => Promise.reject(new Error('socket hang up'))))
    await expect(threw.send(MESSAGE)).rejects.toMatchObject({ code: 'EMAIL_SEND_THREW', outcomeUnknown: true })

    const unconfigured = createEmailReminderChannel(service(async () => ({ success: true }), false))
    await expect(unconfigured.send(MESSAGE)).rejects.toMatchObject({ code: 'EMAIL_NOT_CONFIGURED', outcomeUnknown: false })
  })
})
