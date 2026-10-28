import { getBranding } from '@/lib/branding/service'
import { formatSigningMoment } from '@/lib/signing/format'

/** The template's name, as the send log speaks of it. */
export const SIGNING_COMPLETED_TEMPLATE = 'signing_completed'

export interface SigningCompletedEmailData {
  /** The company the document was signed for. */
  companyName: string
  /** The document's title as the sender named it. */
  title: string
  /** ISO instant the last signature landed. */
  completedAt: string
  /** Everyone who signed, in order, as their BankID names them. */
  signers: string[]
  /** The public page where anyone checks a copy against what was signed. */
  verifyUrl: string
  /** Brand override (WL-13): the app name of the company's brand. Absent = platform default. */
  appName?: string
}

const SANS = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function generateSigningCompletedEmailSubject(data: SigningCompletedEmailData): string {
  return `"${data.title}" är signerat av alla`
}

/**
 * The signed copy goes to everyone who signed and to the sender: every
 * signing service hands each party their copy. The PDF is attached (the
 * Signeringsbevis page says who signed, as what and when); the evidence
 * package never is, it carries every signer's full personnummer. Swedish
 * only, like the other signing mails.
 */
export function generateSigningCompletedEmailHtml(data: SigningCompletedEmailData): string {
  const appName = data.appName ?? getBranding().appName
  const title = escapeHtml(data.title)
  const company = escapeHtml(data.companyName)
  const moment = escapeHtml(formatSigningMoment(data.completedAt))
  const verifyUrl = escapeHtml(data.verifyUrl)
  const signers = data.signers.map((name) => `<li style="margin: 0 0 4px 0;">${escapeHtml(name)}</li>`).join('')

  return `
<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} är signerat</title>
</head>
<body style="margin: 0; padding: 0; font-family: ${SANS}; line-height: 1.6; color: #374151; background-color: #f5f4f1;">
  <div style="max-width: 520px; margin: 0 auto; padding: 40px 20px;">
    <div style="background: #ffffff; border-radius: 12px; padding: 40px 32px; border: 1px solid #e5e5e5;">
      <p style="margin: 0 0 4px 0; font-size: 13px; color: #888; letter-spacing: 0.05em;">${escapeHtml(appName.toUpperCase())}</p>
      <h1 style="margin: 0 0 16px 0; font-size: 22px; font-weight: 600; color: #111;">${title} är signerat</h1>
      <p style="margin: 0 0 16px 0; font-size: 15px;">Alla har signerat <strong>${title}</strong> för ${company} med BankID. Den sista underskriften kom ${moment}.</p>
      <ul style="margin: 0 0 16px 0; padding-left: 20px; font-size: 15px;">${signers}</ul>
      <p style="margin: 0 0 16px 0; font-size: 15px;">
        Den signerade kopian är bifogad. Signeringsbeviset sist i dokumentet visar vem som skrev under, som vad och när.
      </p>
      <p style="margin: 0; font-size: 13px; color: #666; word-break: break-all;">
        Vill någon kontrollera att en kopia är äkta kan den laddas upp på <a href="${verifyUrl}" style="color: #666;">${verifyUrl}</a>.
      </p>
    </div>
  </div>
</body>
</html>`
}

export function generateSigningCompletedEmailText(data: SigningCompletedEmailData): string {
  return [
    `Alla har signerat "${data.title}" för ${data.companyName} med BankID. Den sista underskriften kom ${formatSigningMoment(data.completedAt)}.`,
    '',
    ...data.signers.map((name) => `- ${name}`),
    '',
    'Den signerade kopian är bifogad. Signeringsbeviset sist i dokumentet visar vem som skrev under, som vad och när.',
    '',
    `Vill någon kontrollera att en kopia är äkta kan den laddas upp på ${data.verifyUrl}.`,
  ].join('\n')
}
