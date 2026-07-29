import { getBranding } from '@/lib/branding/service'

export interface ConsentExpiryEmailData {
  bankName: string
  daysUntilExpiry: number
  renewalUrl: string
  /** The company the bank connection belongs to. Shown so the recipient knows
   * which of their companies the email concerns; never used as the sender. */
  companyName: string
  isExpired: boolean
}

/**
 * Consent expiry notification emails.
 *
 * Tone and layout are deliberately calm: a PSD2 consent running out is
 * routine, not an incident. No red, no urgency chrome; the email is signed
 * by the app (never the recipient's own company), states plainly why the
 * recipient got it, and shows the destination URL in plain text next to the
 * button so it does not pattern-match phishing.
 */

const SERIF = `Georgia, 'Times New Roman', serif`
const SANS = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`

function dagar(n: number): string {
  return `${n} ${n === 1 ? 'dag' : 'dagar'}`
}

/**
 * Generate HTML email for consent expiry notification
 */
export function generateConsentExpiryEmailHtml(data: ConsentExpiryEmailData): string {
  const { bankName, daysUntilExpiry, renewalUrl, companyName, isExpired } = data
  const { appName, supportEmail } = getBranding()

  const title = isExpired
    ? 'Bankkopplingen behöver förnyas'
    : `Bankkopplingen löper ut om ${dagar(daysUntilExpiry)}`

  const intro = isExpired
    ? `Banksamtycket för <strong>${bankName}</strong> har löpt ut och den automatiska hämtningen av nya transaktioner är pausad.`
    : `Banksamtycket för <strong>${bankName}</strong> löper ut om ${dagar(daysUntilExpiry)}.`

  const explanation =
    'Det här är väntat: av säkerhetsskäl gäller ett banksamtycke (PSD2) bara en begränsad tid, och därefter behöver det godkännas på nytt hos banken.'

  const consequence = isExpired
    ? 'Ingenting har försvunnit. Redan hämtade transaktioner och din bokföring påverkas inte, och när kopplingen är förnyad hämtas mellanliggande transaktioner ikapp.'
    : 'Förnya gärna i förväg så fortsätter transaktionerna att hämtas utan avbrott. Din bokföring påverkas inte.'

  return `
<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
</head>
<body style="margin: 0; padding: 0; font-family: ${SANS}; line-height: 1.6; color: #374151; background-color: #f5f4f1;">
  <div style="max-width: 560px; margin: 0 auto; padding: 40px 20px;">
    <div style="background: #ffffff; border: 1px solid #e7e5e0; border-radius: 12px; padding: 40px;">

      <div style="font-family: ${SERIF}; font-size: 19px; color: #111111; margin-bottom: 28px;">
        ${appName}
      </div>

      <h1 style="margin: 0 0 16px 0; font-family: ${SERIF}; font-size: 23px; font-weight: 400; color: #111111; line-height: 1.3;">
        ${title}
      </h1>

      <p style="margin: 0 0 14px 0; font-size: 15px;">${intro}</p>
      <p style="margin: 0 0 14px 0; font-size: 15px;">${explanation}</p>
      <p style="margin: 0 0 28px 0; font-size: 15px;">${consequence}</p>

      <table role="presentation" style="width: 100%; border-collapse: collapse; margin-bottom: 28px; font-size: 14px;">
        <tr>
          <td style="padding: 8px 0; border-top: 1px solid #ececea; color: #9ca3af; width: 90px;">Bank</td>
          <td style="padding: 8px 0; border-top: 1px solid #ececea; color: #111111;">${bankName}</td>
        </tr>
        ${companyName ? `
        <tr>
          <td style="padding: 8px 0; border-top: 1px solid #ececea; border-bottom: 1px solid #ececea; color: #9ca3af;">Företag</td>
          <td style="padding: 8px 0; border-top: 1px solid #ececea; border-bottom: 1px solid #ececea; color: #111111;">${companyName}</td>
        </tr>
        ` : ''}
      </table>

      <div style="margin-bottom: 12px;">
        <a href="${renewalUrl}" style="display: inline-block; background: #1a1a1a; color: #ffffff; padding: 12px 26px; border-radius: 99px; text-decoration: none; font-weight: 500; font-size: 14px;">
          Förnya bankkopplingen
        </a>
      </div>

      <p style="margin: 0 0 32px 0; font-size: 13px; color: #9ca3af;">
        Knappen leder till ${renewalUrl}.<br>
        Du kan också logga in som vanligt och gå till Inställningar och sedan Bank.
      </p>

      <div style="padding-top: 20px; border-top: 1px solid #ececea;">
        <p style="margin: 0 0 12px 0; font-size: 14px; color: #374151;">
          Med vänliga hälsningar,<br>
          <strong>${appName}</strong>
        </p>
        <p style="margin: 0; font-size: 12.5px; color: #9ca3af;">
          Du får det här mejlet eftersom det finns en bankkoppling i ${appName}${companyName ? ` för ${companyName}` : ''}.
          Undrar du något? Mejla <a href="mailto:${supportEmail}" style="color: #6b7280;">${supportEmail}</a>.
        </p>
      </div>
    </div>
  </div>
</body>
</html>
`
}

/**
 * Generate plain text email for consent expiry notification
 */
export function generateConsentExpiryEmailText(data: ConsentExpiryEmailData): string {
  const { bankName, daysUntilExpiry, renewalUrl, companyName, isExpired } = data
  const { appName, supportEmail } = getBranding()

  let text = ''

  if (isExpired) {
    text += `Bankkopplingen behöver förnyas\n\n`
    text += `Banksamtycket för ${bankName} har löpt ut och den automatiska hämtningen av nya transaktioner är pausad.\n\n`
  } else {
    text += `Bankkopplingen löper ut om ${dagar(daysUntilExpiry)}\n\n`
    text += `Banksamtycket för ${bankName} löper ut om ${dagar(daysUntilExpiry)}.\n\n`
  }

  text += `Det här är väntat: av säkerhetsskäl gäller ett banksamtycke (PSD2) bara en begränsad tid, och därefter behöver det godkännas på nytt hos banken.\n\n`

  if (isExpired) {
    text += `Ingenting har försvunnit. Redan hämtade transaktioner och din bokföring påverkas inte, och när kopplingen är förnyad hämtas mellanliggande transaktioner ikapp.\n\n`
  } else {
    text += `Förnya gärna i förväg så fortsätter transaktionerna att hämtas utan avbrott. Din bokföring påverkas inte.\n\n`
  }

  text += `Bank: ${bankName}\n`
  if (companyName) text += `Företag: ${companyName}\n`
  text += `\nFörnya bankkopplingen: ${renewalUrl}\n`
  text += `Du kan också logga in som vanligt och gå till Inställningar och sedan Bank.\n\n`
  text += `Med vänliga hälsningar,\n`
  text += `${appName}\n\n`
  text += `Du får det här mejlet eftersom det finns en bankkoppling i ${appName}${companyName ? ` för ${companyName}` : ''}. Undrar du något? Mejla ${supportEmail}.\n`

  return text
}

/**
 * Generate email subject for consent expiry notification
 */
export function generateConsentExpiryEmailSubject(data: ConsentExpiryEmailData): string {
  const suffix = data.companyName ? ` - ${data.companyName}` : ''
  if (data.isExpired) {
    return `Förnya bankkopplingen till ${data.bankName}${suffix}`
  }
  return `Bankkopplingen till ${data.bankName} löper ut om ${dagar(data.daysUntilExpiry)}${suffix}`
}
