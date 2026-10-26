import { getBranding } from '@/lib/branding/service'
import { formatSigningMoment } from '@/lib/signing/format'

/** The template's name, as the send log speaks of it. */
export const SIGNING_REQUEST_TEMPLATE = 'signing_request'

export interface SigningRequestEmailData {
  /** The company the document is signed for. */
  companyName: string
  /** Who asks: the sender's name, or the company's own. */
  requester: string
  /** The document's title as the sender named it. */
  title: string
  signingUrl: string
  /** ISO instant the link runs out. */
  expiresAt: string
  /** The sender's message to the signer, when they wrote one. */
  message?: string | null
  /** A reminder of a request the signer already got. */
  reminder?: boolean
  /** Brand override (WL-13): the app name of the company's brand. Absent = platform default. */
  appName?: string
}

const SANS = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function generateSigningRequestEmailSubject(data: SigningRequestEmailData): string {
  return `${data.reminder ? 'Påminnelse: ' : ''}Signera "${data.title}" från ${data.companyName} med BankID`
}

/**
 * Plain and calm, the tone of the payment signing link: who asks, what the
 * document is, the link with its URL in clear text beside the button (so it
 * does not pattern-match phishing), and when the link runs out. The signer
 * may be anyone the company deals with, so Swedish only, like the other
 * signing mails.
 */
export function generateSigningRequestEmailHtml(data: SigningRequestEmailData): string {
  const appName = data.appName ?? getBranding().appName
  const company = escapeHtml(data.companyName)
  const requester = escapeHtml(data.requester)
  const title = escapeHtml(data.title)
  const url = escapeHtml(data.signingUrl)
  const expiry = escapeHtml(formatSigningMoment(data.expiresAt))
  const message = data.message?.trim()
  const messageBlock = message
    ? `<p style="margin: 0 0 16px 0; font-size: 15px; padding-left: 12px; border-left: 3px solid #e5e5e5; white-space: pre-line;">${escapeHtml(message)}</p>`
    : ''
  const lead = data.reminder
    ? `<strong>${requester}</strong> väntar fortfarande på din underskrift av <strong>${title}</strong> för ${company}.`
    : `<strong>${requester}</strong> ber dig signera <strong>${title}</strong> för ${company} med BankID.`

  return `
<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Signera ${title}</title>
</head>
<body style="margin: 0; padding: 0; font-family: ${SANS}; line-height: 1.6; color: #374151; background-color: #f5f4f1;">
  <div style="max-width: 520px; margin: 0 auto; padding: 40px 20px;">
    <div style="background: #ffffff; border-radius: 12px; padding: 40px 32px; border: 1px solid #e5e5e5;">
      <p style="margin: 0 0 4px 0; font-size: 13px; color: #888; letter-spacing: 0.05em;">${escapeHtml(appName.toUpperCase())}</p>
      <h1 style="margin: 0 0 16px 0; font-size: 22px; font-weight: 600; color: #111;">Signera ${title}</h1>
      <p style="margin: 0 0 16px 0; font-size: 15px;">${lead}</p>
      ${messageBlock}
      <p style="margin: 0 0 16px 0; font-size: 15px;">
        Öppna länken, läs dokumentet och signera med ditt BankID. Inget är signerat förrän du har godkänt i BankID-appen.
      </p>
      <div style="margin: 28px 0;">
        <a href="${url}" style="display: inline-block; background: #111; color: #fff; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-size: 14px; font-weight: 500;">Läs och signera</a>
      </div>
      <p style="margin: 0 0 16px 0; font-size: 13px; color: #666; word-break: break-all;">
        Länken går till: <a href="${url}" style="color: #666;">${url}</a>
      </p>
      <p style="margin: 0; font-size: 13px; color: #999;">
        Länken är personlig och gäller till ${expiry}. Om du inte väntade dig det här mejlet kan du bortse från det.
      </p>
    </div>
  </div>
</body>
</html>`
}

export function generateSigningRequestEmailText(data: SigningRequestEmailData): string {
  const lines = [
    data.reminder
      ? `${data.requester} väntar fortfarande på din underskrift av "${data.title}" för ${data.companyName}.`
      : `${data.requester} ber dig signera "${data.title}" för ${data.companyName} med BankID.`,
  ]
  const message = data.message?.trim()
  if (message) lines.push('', message)
  lines.push(
    '',
    'Öppna länken, läs dokumentet och signera med ditt BankID. Inget är signerat förrän du har godkänt i BankID-appen.',
    '',
    `Läs och signera: ${data.signingUrl}`,
    '',
    `Länken är personlig och gäller till ${formatSigningMoment(data.expiresAt)}. Om du inte väntade dig det här mejlet kan du bortse från det.`,
  )
  return lines.join('\n')
}
