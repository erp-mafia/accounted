import { getBranding } from '@/lib/branding/service'
import { escapeHtml, sanitizeSubjectLine } from './user-text'

/**
 * Welcome email, sent once to every new confirmed account by the lifecycle
 * cron (lib/lifecycle-emails/welcome.ts).
 *
 * Written as a short letter from a person, not a product announcement: one
 * line on what the product does, the three steps that get the books running
 * (the same steps the Hem checklist shows, in the same order and words), one
 * button, and a reply-to-this-mail close. When branding has no sender name
 * the letter is signed by the app instead and the "I" phrasing becomes "we".
 *
 * Voice rules the copy follows on purpose: no em or en dashes, no emoji, at
 * most one exclamation mark, key-value rows for the actionable steps, and the
 * one dry joke is aimed at software, never at the reader.
 */

export type WelcomeEmailLang = 'sv' | 'en'

export interface WelcomeEmailData {
  /**
   * First name from the auth profile (BankID or Google supply one, email
   * signups usually do not). null renders the bare greeting. User-controlled
   * text: escaped in HTML, forced single-line in the subject.
   */
  firstName: string | null
  lang: WelcomeEmailLang
}

interface WelcomeCopy {
  htmlLang: string
  subject: string
  greeting: string
  intro: string
  stepsHeading: string
  steps: Array<{ label: string; detail: string }>
  cta: string
  close: string
  signoff: string
  signer: string
  footer: string
}

function resolveCopy(data: WelcomeEmailData): WelcomeCopy {
  const { appName, welcomeSenderName } = getBranding()
  const signer = welcomeSenderName.trim()
  const personal = signer.length > 0
  const name = data.firstName?.trim() || ''

  if (data.lang === 'en') {
    return {
      htmlLang: 'en',
      subject: `Welcome to ${appName}${name ? `, ${name}` : ''}`,
      greeting: `Hi${name ? ` ${name}` : ''},`,
      intro: `Welcome. ${appName} does the bookkeeping together with you, instead of you doing it for the software ;)`,
      stepsHeading: 'Getting started',
      steps: [
        { label: 'Bring in your books', detail: 'import from your old system or upload a SIE file' },
        { label: 'Connect your bank', detail: 'transactions are fetched automatically, or import a statement' },
        { label: 'Snap a receipt', detail: 'it is read and waits for you in the inbox' },
      ],
      cta: `Open ${appName}`,
      close: personal
        ? 'If you get stuck, reply to this email and I will help you.'
        : 'If you get stuck, reply to this email and we will help you.',
      signoff: 'Kind regards,',
      signer: personal ? signer : appName,
      footer: `You are receiving this email because you created an account on ${appName}.`,
    }
  }

  return {
    htmlLang: 'sv',
    subject: `Välkommen till ${appName}${name ? `, ${name}` : ''}`,
    greeting: `Hej${name ? ` ${name}` : ''},`,
    intro: `Välkommen. ${appName} gör bokföringen tillsammans med dig, i stället för att du gör den åt programmet ;)`,
    stepsHeading: 'Så kommer du igång',
    steps: [
      { label: 'Få in din bokföring', detail: 'importera från ditt gamla system eller ladda upp en SIE-fil' },
      { label: 'Koppla banken', detail: 'transaktionerna hämtas automatiskt, eller importera ett kontoutdrag' },
      { label: 'Fota ett kvitto', detail: 'underlaget tolkas och väntar på dig i inkorgen' },
    ],
    cta: `Öppna ${appName}`,
    close: personal
      ? 'Fastnar du, svara på det här mejlet så hjälper jag dig.'
      : 'Fastnar du, svara på det här mejlet så hjälper vi dig.',
    signoff: personal ? 'Mvh' : 'Med vänliga hälsningar,',
    signer: personal ? signer : appName,
    footer: `Du får det här mejlet för att du skapade ett konto på ${appName}.`,
  }
}

export function generateWelcomeEmailSubject(data: WelcomeEmailData): string {
  return sanitizeSubjectLine(resolveCopy(data).subject)
}

const SERIF = `Georgia, 'Times New Roman', serif`
const SANS = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`

export function generateWelcomeEmailHtml(data: WelcomeEmailData): string {
  const copy = resolveCopy(data)
  const { appName, appUrl } = getBranding()
  const url = escapeHtml(appUrl)

  const stepRows = copy.steps
    .map(
      (step, i) => `
        <tr>
          <td style="padding: 8px 12px 8px 0; ${i > 0 ? 'border-top: 1px solid #ececea;' : ''} color: #111111; white-space: nowrap; vertical-align: top;">${escapeHtml(step.label)}</td>
          <td style="padding: 8px 0; ${i > 0 ? 'border-top: 1px solid #ececea;' : ''} color: #374151;">${escapeHtml(step.detail)}</td>
        </tr>`,
    )
    .join('')

  return `
<!DOCTYPE html>
<html lang="${copy.htmlLang}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(copy.subject)}</title>
</head>
<body style="margin: 0; padding: 0; font-family: ${SANS}; line-height: 1.6; color: #374151; background-color: #f5f4f1;">
  <div style="max-width: 560px; margin: 0 auto; padding: 40px 20px;">
    <div style="background: #ffffff; border: 1px solid #e7e5e0; border-radius: 12px; padding: 40px;">

      <div style="font-family: ${SERIF}; font-size: 19px; color: #111111; margin-bottom: 28px;">
        ${escapeHtml(appName)}
      </div>

      <p style="margin: 0 0 14px 0; font-size: 15px;">${escapeHtml(copy.greeting)}</p>
      <p style="margin: 0 0 24px 0; font-size: 15px;">${escapeHtml(copy.intro)}</p>

      <p style="margin: 0 0 6px 0; font-family: ${SERIF}; font-size: 19px; color: #111111;">${escapeHtml(copy.stepsHeading)}</p>
      <table role="presentation" style="width: 100%; border-collapse: collapse; margin-bottom: 28px; font-size: 14px;">${stepRows}
      </table>

      <div style="margin: 0 0 8px 0;">
        <a href="${url}" style="display: inline-block; background: #111111; color: #ffffff; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-size: 14px; font-weight: 500;">
          ${escapeHtml(copy.cta)}
        </a>
      </div>
      <p style="margin: 0 0 28px 0; font-size: 13px; color: #9ca3af;">${url}</p>

      <p style="margin: 0 0 14px 0; font-size: 15px;">${escapeHtml(copy.close)}</p>

      <p style="margin: 0; font-size: 15px;">
        ${escapeHtml(copy.signoff)}<br>
        ${escapeHtml(copy.signer)}
      </p>
    </div>

    <p style="margin: 16px 0 0 0; font-size: 12px; color: #9ca3af; text-align: center;">
      ${escapeHtml(copy.footer)}
    </p>
  </div>
</body>
</html>`
}

export function generateWelcomeEmailText(data: WelcomeEmailData): string {
  const copy = resolveCopy(data)
  const { appUrl } = getBranding()

  const steps = copy.steps.map((step) => `${step.label}: ${step.detail}`).join('\n')

  return `${copy.greeting}

${copy.intro}

${copy.stepsHeading}

${steps}

${copy.cta}: ${appUrl}

${copy.close}

${copy.signoff}
${copy.signer}

${copy.footer}`
}
