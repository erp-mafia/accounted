import { getBranding } from '@/lib/branding/service'
import { formatSigningLinkExpiry } from '@/lib/payments/orders/signing-link-expiry'
import { formatCurrency } from '@/lib/utils'

/** The template's name, as the send log speaks of it. */
export const PAYMENT_SIGNING_REQUEST_TEMPLATE = 'payment_signing_request'

export interface PaymentSigningRequestEmailData {
  /** The company the payments leave from. */
  companyName: string
  /** Who asks: the byrå's name, the sender's name, or the company's own. */
  requester: string
  orderCount: number
  totalAmount: number
  currency: string
  signingUrl: string
  /** ISO instant the link runs out. */
  expiresAt: string
  /** The sender's message to the signer, when they wrote one. */
  note?: string | null
  /** Brand override (WL-13): the app name of the company's brand. Absent = platform default. */
  appName?: string
}

const SANS = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** "3 betalningar" / "en betalning". */
function paymentsPhrase(count: number): string {
  return count === 1 ? 'en betalning' : `${count} betalningar`
}

export function generatePaymentSigningRequestEmailSubject(data: PaymentSigningRequestEmailData): string {
  return `Signera ${paymentsPhrase(data.orderCount)} från ${data.companyName} med BankID`
}

/**
 * Plain and calm, the tone of the signatory link for the bank: who asks, how
 * many payments and how much, what to have ready, the link with its URL in
 * clear text beside the button (so it does not pattern-match phishing), and
 * when the link runs out. Nothing is paid until the recipient signs with
 * BankID at the bank. The recipient is a firmatecknare, so Swedish only.
 */
export function generatePaymentSigningRequestEmailHtml(data: PaymentSigningRequestEmailData): string {
  const appName = data.appName ?? getBranding().appName
  const company = escapeHtml(data.companyName)
  const requester = escapeHtml(data.requester)
  const total = escapeHtml(formatCurrency(data.totalAmount, data.currency))
  const url = escapeHtml(data.signingUrl)
  const expiry = escapeHtml(formatSigningLinkExpiry(data.expiresAt))
  const note = data.note?.trim()
  const noteBlock = note
    ? `<p style="margin: 0 0 16px 0; font-size: 15px; padding-left: 12px; border-left: 3px solid #e5e5e5; white-space: pre-line;">${escapeHtml(note)}</p>`
    : ''

  return `
<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Signera betalningar från ${company}</title>
</head>
<body style="margin: 0; padding: 0; font-family: ${SANS}; line-height: 1.6; color: #374151; background-color: #f5f4f1;">
  <div style="max-width: 520px; margin: 0 auto; padding: 40px 20px;">
    <div style="background: #ffffff; border-radius: 12px; padding: 40px 32px; border: 1px solid #e5e5e5;">
      <p style="margin: 0 0 4px 0; font-size: 13px; color: #888; letter-spacing: 0.05em;">${escapeHtml(appName.toUpperCase())}</p>
      <h1 style="margin: 0 0 16px 0; font-size: 22px; font-weight: 600; color: #111;">Signera betalningar från ${company}</h1>
      <p style="margin: 0 0 16px 0; font-size: 15px;">
        <strong>${requester}</strong> har förberett ${paymentsPhrase(data.orderCount)} från ${company} på totalt <strong>${total}</strong> och ber dig som firmatecknare att signera med BankID.
      </p>
      ${noteBlock}
      <p style="margin: 0 0 16px 0; font-size: 15px;">
        Ha det här redo: BankID, och behörighet att betala från företagets konto hos banken. Öppna länken, granska betalningarna och signera. Inget betalas förrän du har signerat.
      </p>
      <div style="margin: 28px 0;">
        <a href="${url}" style="display: inline-block; background: #111; color: #fff; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-size: 14px; font-weight: 500;">Granska och signera</a>
      </div>
      <p style="margin: 0 0 16px 0; font-size: 13px; color: #666; word-break: break-all;">
        Länken går till: <a href="${url}" style="color: #666;">${url}</a>
      </p>
      <p style="margin: 0 0 8px 0; font-size: 13px; color: #999;">
        Länken är personlig och gäller till ${expiry}. Om du inte väntade dig det här mejlet kan du bortse från det.
      </p>
      <p style="margin: 0; font-size: 13px; color: #999;">
        Betalningarna initieras via Open Payments Europe AB, betalningsinstitut under Finansinspektionens tillsyn.
      </p>
    </div>
  </div>
</body>
</html>`
}

export function generatePaymentSigningRequestEmailText(data: PaymentSigningRequestEmailData): string {
  const total = formatCurrency(data.totalAmount, data.currency)
  const lines = [
    `${data.requester} har förberett ${paymentsPhrase(data.orderCount)} från ${data.companyName} på totalt ${total} och ber dig som firmatecknare att signera med BankID.`,
  ]
  const note = data.note?.trim()
  if (note) lines.push('', note)
  lines.push(
    '',
    'Ha det här redo: BankID, och behörighet att betala från företagets konto hos banken. Öppna länken, granska betalningarna och signera. Inget betalas förrän du har signerat.',
    '',
    `Granska och signera: ${data.signingUrl}`,
    '',
    `Länken är personlig och gäller till ${formatSigningLinkExpiry(data.expiresAt)}. Om du inte väntade dig det här mejlet kan du bortse från det.`,
    '',
    'Betalningarna initieras via Open Payments Europe AB, betalningsinstitut under Finansinspektionens tillsyn.',
  )
  return lines.join('\n')
}
