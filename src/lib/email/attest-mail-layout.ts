/**
 * The one look of the attest mails that list invoices (the batched request
 * and reminder, the answer back to the registrant, the overdue and blocked
 * notices): the brand's name on top, a heading, the body, one button and a
 * quiet footer. Inline styles, the way every mail client renders them.
 */

import { getBranding } from '@/lib/branding/service'

const SANS = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** A paragraph of plain text, escaped. */
export function attestMailParagraph(text: string): string {
  return `<p style="margin: 0 0 16px 0; font-size: 15px;">${escapeHtml(text)}</p>`
}

/** Invoices as a bulleted list; each item is HTML the caller escaped. */
export function attestMailList(itemsHtml: string[]): string {
  return `<ul style="margin: 0 0 16px 0; padding-left: 20px; font-size: 15px;">${itemsHtml.map((item) => `<li style="margin: 0 0 6px 0;">${item}</li>`).join('')}</ul>`
}

export function attestMailHtml(input: {
  /** The heading and the document title, plain text. */
  title: string
  /** The body between the heading and the button, HTML the caller escaped. */
  bodyHtml: string
  button: { label: string; url: string }
  /** Show the button's URL in clear text below it (so the mail does not pattern-match phishing). */
  showUrl?: boolean
  footer: string
  /** Brand override (WL-13): the app name of the company's brand. Absent = platform default. */
  appName?: string
}): string {
  const appName = input.appName ?? getBranding().appName
  const title = escapeHtml(input.title)
  const url = escapeHtml(input.button.url)
  const clearUrl = input.showUrl
    ? `<p style="margin: 0 0 16px 0; font-size: 13px; color: #666; word-break: break-all;">Länken går till: <a href="${url}" style="color: #666;">${url}</a></p>`
    : ''
  return `
<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
</head>
<body style="margin: 0; padding: 0; font-family: ${SANS}; line-height: 1.6; color: #374151; background-color: #f5f4f1;">
  <div style="max-width: 520px; margin: 0 auto; padding: 40px 20px;">
    <div style="background: #ffffff; border-radius: 12px; padding: 40px 32px; border: 1px solid #e5e5e5;">
      <p style="margin: 0 0 4px 0; font-size: 13px; color: #888; letter-spacing: 0.05em;">${escapeHtml(appName.toUpperCase())}</p>
      <h1 style="margin: 0 0 16px 0; font-size: 22px; font-weight: 600; color: #111;">${title}</h1>
      ${input.bodyHtml}
      <div style="margin: 28px 0;">
        <a href="${url}" style="display: inline-block; background: #111; color: #fff; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-size: 14px; font-weight: 500;">${escapeHtml(input.button.label)}</a>
      </div>
      ${clearUrl}
      <p style="margin: 0; font-size: 13px; color: #999;">${escapeHtml(input.footer)}</p>
    </div>
  </div>
</body>
</html>`
}
