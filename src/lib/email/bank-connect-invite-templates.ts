import { getBranding } from '@/lib/branding/service'

/** The template's name, as the send log and the invite row speak of it. */
export const BANK_CONNECT_INVITE_TEMPLATE = 'bank_connect_invite'

export interface BankConnectInviteEmailData {
  /** The company whose bank is to be connected. */
  companyName: string
  /** Who asks: the byrå's name when the sender acts through the company's team, else the company's own name. */
  requester: string
  /** The bank, when the sender chose one; null lets the firmatecknare pick on the page. */
  bankName: string | null
  inviteUrl: string
  /** The payments verification is offered after the consent. */
  offerPayments: boolean
  /** Brand override (WL-13): the app name of the company's brand. Absent = platform default. */
  appName?: string
}

const SANS = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** "Swedbank" becomes "hos Swedbank"; no bank, no phrase. */
function atBank(bankName: string | null): string {
  return bankName ? ` hos ${bankName}` : ''
}

export function generateBankConnectInviteEmailSubject(data: BankConnectInviteEmailData): string {
  return `Koppla banken för ${data.companyName} med BankID`
}

/**
 * Plain and calm, the tone of the consent-expiry mails: who asks, what it is,
 * what to have ready, the link with its URL in clear text beside the button
 * (so it does not pattern-match phishing), and how long the link holds. The
 * recipient is a firmatecknare, so the mail is Swedish only.
 */
export function generateBankConnectInviteEmailHtml(data: BankConnectInviteEmailData): string {
  const appName = data.appName ?? getBranding().appName
  const company = escapeHtml(data.companyName)
  const requester = escapeHtml(data.requester)
  const bank = data.bankName ? escapeHtml(data.bankName) : null
  const url = escapeHtml(data.inviteUrl)
  const paymentsLine = data.offerPayments
    ? `<p style="margin: 0 0 16px 0; font-size: 15px;">Efteråt kan du också verifiera företaget för betalningar via banken (kundkännedom hos betalningsleverantören). Det tar cirka fem minuter med BankID och är frivilligt.</p>`
    : ''

  return `
<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Koppla banken för ${company}</title>
</head>
<body style="margin: 0; padding: 0; font-family: ${SANS}; line-height: 1.6; color: #374151; background-color: #f5f4f1;">
  <div style="max-width: 520px; margin: 0 auto; padding: 40px 20px;">
    <div style="background: #ffffff; border-radius: 12px; padding: 40px 32px; border: 1px solid #e5e5e5;">
      <p style="margin: 0 0 4px 0; font-size: 13px; color: #888; letter-spacing: 0.05em;">${escapeHtml(appName.toUpperCase())}</p>
      <h1 style="margin: 0 0 16px 0; font-size: 22px; font-weight: 600; color: #111;">Koppla banken för ${company}</h1>
      <p style="margin: 0 0 16px 0; font-size: 15px;">
        <strong>${requester}</strong> ber dig som firmatecknare att koppla ${company}s bankkonto${atBank(bank)} till ${escapeHtml(appName)}, så att transaktionerna hämtas automatiskt till bokföringen.
      </p>
      <p style="margin: 0 0 16px 0; font-size: 15px;">
        Ha det här redo: BankID, och behörighet till företagets konton hos banken. Det tar några minuter: öppna länken, ${bank ? 'signera' : 'välj bank, signera'} med BankID och välj vilka konton som ska hämtas.
      </p>
      ${paymentsLine}
      <div style="margin: 28px 0;">
        <a href="${url}" style="display: inline-block; background: #111; color: #fff; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-size: 14px; font-weight: 500;">Koppla banken</a>
      </div>
      <p style="margin: 0 0 16px 0; font-size: 13px; color: #666; word-break: break-all;">
        Länken går till: <a href="${url}" style="color: #666;">${url}</a>
      </p>
      <p style="margin: 0 0 8px 0; font-size: 13px; color: #999;">
        Länken är personlig och giltig i 7 dagar. Om du inte väntade dig det här mejlet kan du bortse från det.
      </p>
      <p style="margin: 0; font-size: 13px; color: #999;">
        Bankdata hämtas via Open Payments Europe AB, betalningsinstitut under Finansinspektionens tillsyn.
      </p>
    </div>
  </div>
</body>
</html>`
}

export function generateBankConnectInviteEmailText(data: BankConnectInviteEmailData): string {
  const appName = data.appName ?? getBranding().appName
  const lines = [
    `${data.requester} ber dig som firmatecknare att koppla ${data.companyName}s bankkonto${atBank(data.bankName)} till ${appName}, så att transaktionerna hämtas automatiskt till bokföringen.`,
    '',
    `Ha det här redo: BankID, och behörighet till företagets konton hos banken. Det tar några minuter: öppna länken, ${data.bankName ? 'signera' : 'välj bank, signera'} med BankID och välj vilka konton som ska hämtas.`,
  ]
  if (data.offerPayments) {
    lines.push('', 'Efteråt kan du också verifiera företaget för betalningar via banken (kundkännedom hos betalningsleverantören). Det tar cirka fem minuter med BankID och är frivilligt.')
  }
  lines.push('', `Koppla banken: ${data.inviteUrl}`, '', 'Länken är personlig och giltig i 7 dagar. Om du inte väntade dig det här mejlet kan du bortse från det.', '', 'Bankdata hämtas via Open Payments Europe AB, betalningsinstitut under Finansinspektionens tillsyn.')
  return lines.join('\n')
}
