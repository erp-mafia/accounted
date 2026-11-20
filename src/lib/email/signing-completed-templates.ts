import { getBranding } from '@/lib/branding/service'
import { formatSigningMoment, formatSigningShortMoment } from '@/lib/signing/format'
import type { MailLogo } from '@/lib/signing/logo'
import {
  SIGNING_MAIL_COLORS as C,
  SIGNING_MAIL_SANS,
  documentCard,
  escapeHtml,
  headingBlock,
  logoBlock,
  oneLine,
  pagesLabel,
  paragraph,
  signingMailPage,
} from '@/lib/email/signing-mail-layout'

/** The template's name, as the send log speaks of it. */
export const SIGNING_COMPLETED_TEMPLATE = 'signing_completed'

export interface SigningCompletedSigner {
  /** The name their BankID gave. */
  name: string
  role: string | null
  /** ISO instant they signed. */
  signedAt: string
}

export interface SigningCompletedEmailData {
  /** The company the document was signed for. */
  companyName: string
  /** The document's title as the sender named it. */
  title: string
  /** ISO instant the last signature landed. */
  completedAt: string
  /** Everyone who signed, in order. */
  signers: SigningCompletedSigner[]
  /** Pages in the original document, when known. */
  pageCount?: number | null
  /** The public page where anyone checks a copy against what was signed. */
  verifyUrl: string
  /** The company logo; absent draws the company's initials. */
  logo?: MailLogo | null
  /** The platform the mail went out through: the brand's app name, else ours. Absent = platform default. */
  platformName?: string
}

const HEADING = 'Dokumentet är signerat av alla'
const ATTACHED = 'Den signerade kopian är bifogad. Signeringsbeviset sist i dokumentet visar vem som skrev under, som vad och när.'

/** The verify URL as a reader types it: no scheme, no trailing slash. */
function bareUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '')
}

function facts(data: SigningCompletedEmailData): string[] {
  const out: string[] = []
  if (data.pageCount && data.pageCount > 0) out.push(pagesLabel(data.pageCount))
  out.push(`${data.signers.length} av ${data.signers.length} har signerat`)
  out.push(`slutfört ${formatSigningMoment(data.completedAt)}`)
  return out
}

function signerRows(signers: SigningCompletedSigner[]): string {
  return signers
    .map(
      (s) => `
          <tr>
            <td colspan="2" style="padding: 0 16px; font-family: ${SIGNING_MAIL_SANS};">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border-top: 1px solid ${C.hairline};">
                <tr>
                  <td valign="top" style="padding: 12px 12px 12px 0; font-size: 14px; line-height: 1.4; color: ${C.ink};">${escapeHtml(s.name)}<br><span style="font-size: 13px; color: ${C.muted};">${escapeHtml(s.role || 'Undertecknare')}</span></td>
                  <td valign="top" align="right" style="padding: 12px 0; font-size: 13px; line-height: 1.4; color: ${C.muted}; white-space: nowrap;">${escapeHtml(formatSigningShortMoment(s.signedAt))}<br>BankID</td>
                </tr>
              </table>
            </td>
          </tr>`,
    )
    .join('')
}

function footer(data: SigningCompletedEmailData): string {
  return `Skickat för ${data.companyName.trim()} med ${data.platformName ?? getBranding().appName}.`
}

export function generateSigningCompletedEmailSubject(data: SigningCompletedEmailData): string {
  return oneLine(`Signerat: ${data.title}`)
}

/**
 * The signed copy goes to everyone who signed and to the sender: every
 * signing service hands each party their copy. The PDF is attached (its
 * Signeringsbevis page says who signed, as what and when); the evidence
 * package never is, it carries every signer's full personnummer. The same
 * look as the request mail. Swedish only, like the other signing mails.
 */
export function generateSigningCompletedEmailHtml(data: SigningCompletedEmailData): string {
  const verifyUrl = escapeHtml(data.verifyUrl)
  return signingMailPage({
    title: escapeHtml(generateSigningCompletedEmailSubject(data)),
    preheader: escapeHtml('Den signerade kopian är bifogad.'),
    blocks: [
      logoBlock(data.companyName, data.logo),
      headingBlock(HEADING),
      documentCard(data.title, facts(data), signerRows(data.signers)),
      paragraph(escapeHtml(ATTACHED)),
      paragraph(
        `Vill någon kontrollera att en kopia är äkta kan den laddas upp på <a href="${verifyUrl}" style="color: ${C.muted};">${escapeHtml(bareUrl(data.verifyUrl))}</a>.`,
        'small',
      ),
    ],
    footer: escapeHtml(footer(data)),
  })
}

export function generateSigningCompletedEmailText(data: SigningCompletedEmailData): string {
  return [
    `${HEADING}.`,
    '',
    data.title,
    facts(data).join(' · '),
    '',
    ...data.signers.map((s) => `- ${s.name}${s.role ? `, ${s.role}` : ''} (${formatSigningShortMoment(s.signedAt)}, BankID)`),
    '',
    ATTACHED,
    '',
    `Vill någon kontrollera att en kopia är äkta kan den laddas upp på ${data.verifyUrl}.`,
    '',
    footer(data),
  ].join('\n')
}
