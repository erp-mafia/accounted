import { getEmailService } from '@/lib/email/service'
import { resolveSigningMailIdentity } from '@/lib/email/signing-mail-sender'
import {
  SIGNING_COMPLETED_TEMPLATE,
  generateSigningCompletedEmailHtml,
  generateSigningCompletedEmailSubject,
  generateSigningCompletedEmailText,
  type SigningCompletedSigner,
} from '@/lib/email/signing-completed-templates'
import type { Logger } from '@/lib/logger'

/**
 * Mail the signed copy of a completed signing request (lib/signing/seal.ts)
 * to each address, one mail per recipient so no one sees the others'
 * addresses. The same sender as the request mail (./signing-mail-sender.ts).
 * A send failure never throws: the copy is in the archive, and a signer
 * with the link can still fetch it there.
 */
export async function sendSigningCompletedMail(params: {
  companyId: string
  companyName: string
  title: string
  completedAt: string
  signers: SigningCompletedSigner[]
  /** Pages in the original document. */
  pageCount?: number | null
  verifyUrl: string
  recipients: string[]
  pdf: { filename: string; bytes: Uint8Array }
  log: Logger
}): Promise<{ sent: number }> {
  const { companyId, log } = params
  if (params.recipients.length === 0) return { sent: 0 }
  const emailService = await getEmailService()
  if (!emailService.isConfigured()) {
    log.warn('email service not configured: signed copy mail skipped', { template: SIGNING_COMPLETED_TEMPLATE })
    return { sent: 0 }
  }
  const sender = await resolveSigningMailIdentity(companyId, params.companyName)
  const data = {
    companyName: params.companyName,
    title: params.title,
    completedAt: params.completedAt,
    signers: params.signers,
    pageCount: params.pageCount ?? null,
    verifyUrl: params.verifyUrl,
    logo: sender.logo,
    platformName: sender.platformName,
  }
  const subject = generateSigningCompletedEmailSubject(data)
  const html = generateSigningCompletedEmailHtml(data)
  const text = generateSigningCompletedEmailText(data)
  const content = Buffer.from(params.pdf.bytes)
  let sent = 0
  for (const to of params.recipients) {
    const result = await emailService.sendEmail({
      to,
      subject,
      html,
      text,
      fromName: sender.fromName ?? undefined,
      fromAddress: sender.fromAddress ?? undefined,
      replyTo: sender.replyTo ?? undefined,
      attachments: [{ filename: params.pdf.filename, content, contentType: 'application/pdf' }],
    })
    // The address is the recipient's: never logged.
    if (result.success) sent++
    else log.error('signed copy mail send failed', new Error(result.error ?? 'unknown'), { template: SIGNING_COMPLETED_TEMPLATE })
  }
  log.info('signed copy mailed', { template: SIGNING_COMPLETED_TEMPLATE, sent, recipients: params.recipients.length })
  return { sent }
}
