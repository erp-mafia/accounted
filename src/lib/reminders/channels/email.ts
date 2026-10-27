import type { EmailService } from '@/lib/email/service'
import { ReminderChannelError, type ReminderChannel } from '../channel'

/**
 * Reminders by email, over whichever EmailService the installation
 * registered. A refusal the service reports (success false) left nothing
 * behind; a thrown send may have gone out, so it is marked outcome unknown.
 */
export function createEmailReminderChannel(service: EmailService): ReminderChannel {
  return {
    kind: 'email',
    async send(message) {
      if (!service.isConfigured()) {
        throw new ReminderChannelError('EMAIL_NOT_CONFIGURED', { outcomeUnknown: false })
      }
      let result
      try {
        result = await service.sendEmail({
          to: message.to,
          cc: message.cc.length > 0 ? message.cc : undefined,
          bcc: message.bcc.length > 0 ? message.bcc : undefined,
          subject: message.subject,
          html: message.html,
          text: message.text,
          replyTo: message.replyTo,
          fromName: message.fromName,
          ...(message.fromAddress ? { fromAddress: message.fromAddress } : {}),
          // The company's own verified sender wins over the brand address.
          from: message.from,
          ...(message.attachments && message.attachments.length > 0 ? { attachments: message.attachments } : {}),
        })
      } catch (error) {
        throw new ReminderChannelError('EMAIL_SEND_THREW', { outcomeUnknown: true, cause: error })
      }
      if (!result.success) {
        throw new ReminderChannelError('EMAIL_SEND_FAILED', { outcomeUnknown: false, detail: result.error })
      }
      return { provider: result.provider ?? 'unknown', providerMessageId: result.messageId ?? null }
    },
  }
}
