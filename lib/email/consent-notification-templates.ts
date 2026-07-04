import { getBranding } from '@/lib/branding/service'

export interface ConsentExpiryEmailData {
  bankName: string
  daysUntilExpiry: number
  renewalUrl: string
  companyName: string
  isExpired: boolean
}

/**
 * Generate HTML email for consent expiry notification
 */
export function generateConsentExpiryEmailHtml(data: ConsentExpiryEmailData): string {
  const { bankName, daysUntilExpiry, renewalUrl, companyName, isExpired } = data
  const { appName } = getBranding()
  const headerColor = isExpired ? '#dc2626' : '#ea580c'
  const title = isExpired
    ? 'Banksynkronisering har stoppats'
    : `Samtycket för ${bankName} löper ut snart`

  return `
<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; background-color: #f9fafb;">
  <div style="max-width: 600px; margin: 0 auto; padding: 40px 20px;">
    <div style="background: white; border-radius: 12px; padding: 40px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
      <div style="text-align: center; margin-bottom: 30px;">
        <div style="display: inline-block; background: ${headerColor}15; color: ${headerColor}; padding: 8px 16px; border-radius: 20px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">
          ${isExpired ? 'Åtgärd krävs' : 'Påminnelse'}
        </div>
      </div>

      <h1 style="margin: 0 0 20px 0; font-size: 22px; font-weight: 600; color: #111; text-align: center;">
        ${title}
      </h1>

      <div style="margin-bottom: 30px;">
        ${isExpired ? `
        <p style="margin: 0 0 15px 0; color: #dc2626; font-weight: 500;">
          PSD2-samtycket för ${bankName} har löpt ut. Automatisk transaktionssynkronisering är stoppad.
        </p>
        <p style="margin: 0 0 15px 0;">
          Förnya anslutningen för att återuppta synkroniseringen.
        </p>
        ` : `
        <p style="margin: 0 0 15px 0;">
          Samtycket för ${bankName} löper ut om ${daysUntilExpiry} ${daysUntilExpiry === 1 ? 'dag' : 'dagar'}.
        </p>
        <p style="margin: 0 0 15px 0;">
          Förnya anslutningen innan samtycket löper ut för att undvika avbrott i transaktionssynkroniseringen.
        </p>
        `}
      </div>

      <div style="text-align: center; margin-bottom: 30px;">
        <a href="${renewalUrl}" style="display: inline-block; background: ${headerColor}; color: white; padding: 14px 28px; border-radius: 8px; text-decoration: none; font-weight: 500; font-size: 14px;">
          ${isExpired ? 'Förnya anslutning' : 'Hantera bankanslutningar'}
        </a>
      </div>

      <div style="padding-top: 20px; border-top: 1px solid #e5e7eb;">
        <p style="margin: 0; color: #666; font-size: 14px;">
          Med vänliga hälsningar,<br>
          <strong>${companyName || appName.toLowerCase()}</strong>
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
  const { appName } = getBranding()

  let text = ''

  if (isExpired) {
    text += `BANKSYNKRONISERING HAR STOPPATS\n`
    text += `=`.repeat(40) + `\n\n`
    text += `PSD2-samtycket för ${bankName} har löpt ut.\n`
    text += `Automatisk transaktionssynkronisering är stoppad.\n\n`
    text += `Förnya anslutningen för att återuppta synkroniseringen.\n\n`
  } else {
    text += `SAMTYCKET FÖR ${bankName.toUpperCase()} LÖPER UT SNART\n`
    text += `=`.repeat(40) + `\n\n`
    text += `Samtycket för ${bankName} löper ut om ${daysUntilExpiry} ${daysUntilExpiry === 1 ? 'dag' : 'dagar'}.\n\n`
    text += `Förnya anslutningen innan samtycket löper ut för att undvika avbrott.\n\n`
  }

  text += `Hantera bankanslutningar: ${renewalUrl}\n\n`
  text += `Med vänliga hälsningar,\n`
  text += `${companyName || appName.toLowerCase()}\n`

  return text
}

/**
 * Generate email subject for consent expiry notification
 */
export function generateConsentExpiryEmailSubject(data: ConsentExpiryEmailData): string {
  if (data.isExpired) {
    return `Banksynkronisering stoppad - ${data.bankName}`
  }
  return `Banksamtycke löper ut om ${data.daysUntilExpiry} ${data.daysUntilExpiry === 1 ? 'dag' : 'dagar'} - ${data.bankName}`
}
