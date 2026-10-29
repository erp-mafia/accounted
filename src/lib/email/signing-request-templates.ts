import { getBranding } from '@/lib/branding/service'
import type { MailLogo } from '@/lib/signing/logo'
import {
  buttonBlock,
  documentCard,
  escapeHtml,
  escapeMultiline,
  formatSigningDeadline,
  headingBlock,
  logoBlock,
  oneLine,
  pagesLabel,
  paragraph,
  signingMailPage,
} from '@/lib/email/signing-mail-layout'

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
  /** Pages in the document, when known when the mail goes out. */
  pageCount?: number | null
  /** How many are asked to sign, when known. */
  signerCount?: number | null
  /** The company logo; absent draws the company's initials. */
  logo?: MailLogo | null
  /** The platform the mail went out through: the brand's app name, else ours. Absent = platform default. */
  platformName?: string
}

const SMALL_PRINT = 'Du läser dokumentet och signerar med BankID. Inget är signerat förrän du godkänner i BankID-appen.'

/** The requester and the company, or the company alone when the company asks itself. */
function whoAsks(data: SigningRequestEmailData): { requester: string | null; company: string } {
  const requester = data.requester.trim()
  const company = data.companyName.trim()
  return { requester: requester && requester.toLocaleLowerCase('sv-SE') !== company.toLocaleLowerCase('sv-SE') ? requester : null, company }
}

function heading(data: SigningRequestEmailData, wrap: (value: string) => string): string {
  const { requester, company } = whoAsks(data)
  const who = requester ? `${wrap(requester)} på ${wrap(company)}` : wrap(company)
  return data.reminder ? `${who} väntar på din underskrift` : `${who} ber dig signera ett dokument`
}

function facts(data: SigningRequestEmailData): string[] {
  const out: string[] = []
  if (data.pageCount && data.pageCount > 0) out.push(pagesLabel(data.pageCount))
  if (data.signerCount && data.signerCount > 0) out.push(`${data.signerCount} undertecknare`)
  out.push(`gäller till ${formatSigningDeadline(data.expiresAt)}`)
  return out
}

function footer(data: SigningRequestEmailData): string {
  return `Skickat för ${data.companyName.trim()} med ${data.platformName ?? getBranding().appName}. Länken är personlig, vidarebefordra inte mejlet.`
}

export function generateSigningRequestEmailSubject(data: SigningRequestEmailData): string {
  return oneLine(`Signera: ${data.title}${data.reminder ? ' (påminnelse)' : ''}`)
}

/**
 * Who asks, the document as a card (pages, signers, when the link runs
 * out), the sender's message as a quote, one button and one line on what
 * happens next. The signer may be anyone the company deals with, so Swedish
 * only, like the other signing mails.
 */
export function generateSigningRequestEmailHtml(data: SigningRequestEmailData): string {
  const message = data.message?.trim()
  const blocks = [
    logoBlock(data.companyName, data.logo),
    headingBlock(heading(data, escapeHtml)),
    documentCard(data.title, facts(data)),
    ...(message ? [paragraph(`&rdquo;${escapeMultiline(message)}&rdquo;`)] : []),
    buttonBlock('Läs och signera', data.signingUrl),
    paragraph(escapeHtml(SMALL_PRINT), 'small'),
  ]
  return signingMailPage({
    title: escapeHtml(generateSigningRequestEmailSubject(data)),
    preheader: escapeHtml(`Läs och signera med BankID. Länken gäller till ${formatSigningDeadline(data.expiresAt)}.`),
    blocks,
    footer: escapeHtml(footer(data)),
  })
}

export function generateSigningRequestEmailText(data: SigningRequestEmailData): string {
  const lines = [`${heading(data, (v) => v)}.`, '', data.title, facts(data).join(' · ')]
  const message = data.message?.trim()
  if (message) lines.push('', `”${message}”`)
  lines.push('', `Läs och signera: ${data.signingUrl}`, '', SMALL_PRINT, '', footer(data))
  return lines.join('\n')
}
