import { getEmailService } from '@/lib/email/service'
import { getSenderForCompany } from '@/lib/email/brand-sender'
import {
  ATTEST_BATCH_TEMPLATE,
  generateAttestBatchEmailHtml,
  generateAttestBatchEmailSubject,
  generateAttestBatchEmailText,
  type AttestBatchEmailData,
} from '@/lib/email/attest-batch-templates'
import {
  ATTEST_NOTICE_TEMPLATE,
  generateAttestNoticeEmailHtml,
  generateAttestNoticeEmailSubject,
  generateAttestNoticeEmailText,
  type AttestNoticeEmailData,
} from '@/lib/email/attest-notice-templates'
import type { Logger } from '@/lib/logger'

interface Rendered {
  subject: string
  html: string
  text: string
}

/**
 * What came of a send:
 * - sent: the provider took it.
 * - unknown: it may have gone out (no answer in time, a server error, a lost
 *   reply; SendEmailResult.outcomeUnknown not false). Read it as sent: a mail
 *   is never sent twice, even if that means once is missed.
 * - refused: the provider said no, or nothing was handed to it: nothing went
 *   out and a later try may go through.
 * - unavailable: no mail service on this installation; no try ever will.
 */
export type AttestMailOutcome = 'sent' | 'unknown' | 'refused' | 'unavailable'

export interface AttestMailSendResult {
  outcome: AttestMailOutcome
}

/** How long a send may take before its outcome is read as unknown: well inside a cron run. */
export const ATTEST_SEND_TIMEOUT_MS = 20_000

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Brand mail (WL-13): the sender follows the brand of the company. Never throws. */
async function send(
  companyId: string,
  email: string,
  log: Logger,
  template: string,
  render: (appName: string | undefined) => Rendered,
): Promise<AttestMailSendResult> {
  let emailService: Awaited<ReturnType<typeof getEmailService>>
  let mail: Rendered
  let sender: Awaited<ReturnType<typeof getSenderForCompany>>
  try {
    // Waits for lib/init, which can fail: then nothing reached the provider either.
    emailService = await getEmailService()
    if (!emailService.isConfigured()) {
      log.warn('email service not configured: attest mail skipped', { template })
      return { outcome: 'unavailable' }
    }
    sender = await getSenderForCompany(companyId)
    mail = render(sender.brand?.appName)
  } catch (error) {
    // Nothing reached the provider.
    log.error('attest mail not prepared', error instanceof Error ? error : new Error(message(error)), { template })
    return { outcome: 'refused' }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ATTEST_SEND_TIMEOUT_MS)
  })
  try {
    const result = await Promise.race([
      emailService.sendEmail({
        to: email,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
        fromName: sender.fromName ?? undefined,
        fromAddress: sender.fromAddress ?? undefined,
        replyTo: sender.replyTo ?? undefined,
      }),
      timeout,
    ])
    if (result === 'timeout') {
      log.warn('attest mail send timed out: it may have gone out', { template })
      return { outcome: 'unknown' }
    }
    if (result.success) {
      // The address is the recipient's and the URL carries the token: neither is logged.
      log.info('attest mail sent', { template, messageId: result.messageId })
      return { outcome: 'sent' }
    }
    const refused = result.outcomeUnknown === false
    log.error('attest mail send failed', new Error(result.error ?? 'unknown'), { template, outcomeUnknown: !refused })
    return { outcome: refused ? 'refused' : 'unknown' }
  } catch (error) {
    // Thrown while the request was out: the provider may have taken it.
    log.error('attest mail send threw', error instanceof Error ? error : new Error(message(error)), { template })
    return { outcome: 'unknown' }
  } finally {
    clearTimeout(timer)
  }
}

/** The batched attest mail to an attester: the invoices waiting on them and the link to answer them all (attest-mail-run.ts). */
export function sendAttestBatchMail(params: {
  companyId: string
  email: string
  data: Omit<AttestBatchEmailData, 'appName'>
  log: Logger
}): Promise<AttestMailSendResult> {
  return send(params.companyId, params.email, params.log, ATTEST_BATCH_TEMPLATE, (appName) => {
    const data: AttestBatchEmailData = { ...params.data, appName }
    return {
      subject: generateAttestBatchEmailSubject(data),
      html: generateAttestBatchEmailHtml(data),
      text: generateAttestBatchEmailText(data),
    }
  })
}

/** The registrant's notice: invoices past their due date without attest, or that nobody can attest (attest-mail-run.ts). */
export function sendAttestNoticeMail(params: {
  companyId: string
  email: string
  data: Omit<AttestNoticeEmailData, 'appName'>
  log: Logger
}): Promise<AttestMailSendResult> {
  return send(params.companyId, params.email, params.log, ATTEST_NOTICE_TEMPLATE, (appName) => {
    const data: AttestNoticeEmailData = { ...params.data, appName }
    return {
      subject: generateAttestNoticeEmailSubject(data),
      html: generateAttestNoticeEmailHtml(data),
      text: generateAttestNoticeEmailText(data),
    }
  })
}
