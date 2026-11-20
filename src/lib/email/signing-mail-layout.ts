/**
 * The one look of the signing mails (the request, its reminder and the
 * signed copy): the company's logo or initials on top, a serif heading, a
 * card for the document, and a footer saying whom it was sent for and
 * through which platform. Table markup with inline styles, the way every
 * mail client renders it; no web fonts, no SVG, no background images.
 */
import { companyInitials, type MailLogo } from '@/lib/signing/logo'

export const SIGNING_MAIL_COLORS = {
  page: '#f6f4f0',
  ink: '#1c1b19',
  body: '#45433f',
  muted: '#6b6862',
  hairline: '#e5e2dc',
  tile: '#efece6',
  glyph: '#d9d5ce',
} as const

const C = SIGNING_MAIL_COLORS
export const SIGNING_MAIL_SANS = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`
const SERIF = `Georgia, 'Times New Roman', Times, serif`

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Escaped, with the writer's line breaks kept. */
export function escapeMultiline(value: string): string {
  return escapeHtml(value).replace(/\r\n|\r|\n/g, '<br>')
}

/** A subject is one line, whatever the title holds. */
export function oneLine(value: string): string {
  return value.replace(/\s*[\r\n]+\s*/g, ' ').trim()
}

/** The day and time a link runs out, Stockholm time: "5 november kl. 14:05". */
export function formatSigningDeadline(iso: string): string {
  const date = new Date(iso)
  const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', day: 'numeric', month: 'long' }).format(date)
  const time = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', hour: '2-digit', minute: '2-digit' }).format(date)
  return `${day} kl. ${time}`
}

export function pagesLabel(count: number): string {
  return `${count} ${count === 1 ? 'sida' : 'sidor'}`
}

/** The company's logo at its own aspect ratio, or its initials on a tile. */
export function logoBlock(companyName: string, logo: MailLogo | null | undefined): string {
  if (logo) {
    const ratio = logo.width / logo.height
    const radius = ratio > 0.8 && ratio < 1.25 ? 'border-radius: 10px; ' : ''
    return `<img src="${escapeHtml(logo.src)}" width="${logo.width}" height="${logo.height}" alt="${escapeHtml(companyName)}" style="display: block; width: ${logo.width}px; height: ${logo.height}px; ${radius}border: 0; outline: none; text-decoration: none;">`
  }
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="48" height="48" align="center" valign="middle" bgcolor="${C.tile}" style="width: 48px; height: 48px; border-radius: 10px; background-color: ${C.tile}; font-family: ${SIGNING_MAIL_SANS}; font-size: 17px; line-height: 48px; font-weight: 600; color: ${C.body};">${escapeHtml(companyInitials(companyName))}</td></tr></table>`
}

export function headingBlock(text: string): string {
  return `<h1 style="margin: 0; font-family: ${SERIF}; font-weight: 400; font-size: 26px; line-height: 1.2; color: ${C.ink};">${text}</h1>`
}

/** A document drawn in table cells: a sheet with a few text lines and "PDF". */
function documentGlyph(): string {
  const bar = (width: number) =>
    `<div style="width: ${width}px; height: 2px; line-height: 2px; font-size: 0; background-color: ${C.glyph}; margin: 0 0 4px 0;">&nbsp;</div>`
  return `<table role="presentation" width="38" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="width: 38px; border: 1px solid ${C.glyph}; border-radius: 3px; border-collapse: separate; background-color: #ffffff;"><tr><td valign="top" style="height: 30px; padding: 8px 7px 0 7px;">${bar(22)}${bar(22)}${bar(22)}${bar(14)}</td></tr><tr><td style="padding: 0 0 5px 7px; font-family: ${SIGNING_MAIL_SANS}; font-size: 7px; line-height: 8px; font-weight: 700; letter-spacing: 0.04em; color: ${C.muted};">PDF</td></tr></table>`
}

/** The document card: the glyph, the title, a line of facts, and optional rows below a hairline. */
export function documentCard(title: string, facts: string[], rows = ''): string {
  const factLine = facts.length > 0 ? `<div style="padding-top: 4px; font-size: 13px; line-height: 1.45; color: ${C.muted};">${facts.map(escapeHtml).join(' &middot; ')}</div>` : ''
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border: 1px solid ${C.hairline}; border-radius: 8px; border-collapse: separate;">
          <tr>
            <td width="40" valign="middle" style="width: 40px; padding: 16px 0 16px 16px;">${documentGlyph()}</td>
            <td valign="middle" style="padding: 16px; font-family: ${SIGNING_MAIL_SANS};">
              <div style="font-size: 15px; line-height: 1.35; font-weight: 600; color: ${C.ink}; word-break: break-word;">${escapeHtml(title)}</div>
              ${factLine}
            </td>
          </tr>${rows}
        </table>`
}

/** The one button: a filled pill that survives Outlook as a square. */
export function buttonBlock(label: string, href: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" bgcolor="${C.ink}" style="border-radius: 99px; background-color: ${C.ink};"><a href="${escapeHtml(href)}" target="_blank" style="display: inline-block; padding: 13px 24px; font-family: ${SIGNING_MAIL_SANS}; font-size: 14px; line-height: 18px; font-weight: 600; color: #ffffff; text-decoration: none; border-radius: 99px;">${escapeHtml(label)}</a></td></tr></table>`
}

export function paragraph(html: string, tone: 'body' | 'small' = 'body'): string {
  return tone === 'body'
    ? `<p style="margin: 0; font-size: 14px; line-height: 1.55; color: ${C.body};">${html}</p>`
    : `<p style="margin: 0; font-size: 13px; line-height: 1.5; color: ${C.muted};">${html}</p>`
}

/**
 * The page: a hidden preview line, the card holding the blocks 24px apart,
 * and the footer under it. Every argument is already escaped HTML.
 */
export function signingMailPage(input: { title: string; preheader: string; blocks: string[]; footer: string }): string {
  const rows = input.blocks
    .map((block, i) => `<tr><td style="padding: 0 0 ${i === input.blocks.length - 1 ? 0 : 24}px 0; font-family: ${SIGNING_MAIL_SANS};">${block}</td></tr>`)
    .join('\n          ')
  return `<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light">
  <meta name="supported-color-schemes" content="light">
  <title>${input.title}</title>
  <style>
    @media (max-width: 600px) { .signing-card { padding: 28px 24px !important; } }
  </style>
</head>
<body style="margin: 0; padding: 0; background-color: ${C.page}; color: ${C.ink}; font-family: ${SIGNING_MAIL_SANS};">
  <div style="display: none; max-height: 0; overflow: hidden; opacity: 0; mso-hide: all; font-size: 1px; line-height: 1px; color: ${C.page};">${input.preheader}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.page}" style="width: 100%; background-color: ${C.page};">
    <tr>
      <td align="center" style="padding: 28px 12px;">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width: 100%; max-width: 560px;">
          <tr>
            <td class="signing-card" bgcolor="#ffffff" style="background-color: #ffffff; border: 1px solid ${C.hairline}; border-radius: 12px; padding: 36px 40px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width: 100%;">
          ${rows}
              </table>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding: 20px 24px 0 24px; font-family: ${SIGNING_MAIL_SANS}; font-size: 12px; line-height: 1.5; color: ${C.muted};">${input.footer}</td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
}
