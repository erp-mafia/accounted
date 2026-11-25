import { getBranding } from '@/lib/branding/service'
import { escapeHtml, sanitizeSubjectLine } from '@/lib/email/user-text'

/** The template's name, as the send log speaks of it. */
export const PEPPOL_PLAN_REQUIRED_TEMPLATE = 'peppol_plan_required'

export interface PeppolPlanRequiredEmailData {
  /** The company that asked for Peppol. */
  companyName: string
  /** The billing page on the company's brand host. */
  billingUrl: string
  /** Brand override: the app name of the company's brand. Absent = platform default. */
  appName?: string
}

const SANS = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`

export function generatePeppolPlanRequiredEmailSubject(): string {
  return sanitizeSubjectLine('Peppol kräver ett betalt abonnemang')
}

function paragraphs(data: PeppolPlanRequiredEmailData): string[] {
  const appName = data.appName ?? getBranding().appName
  return [
    `Vi har tagit emot begäran om Peppol för ${data.companyName}. Peppol ingår i de betalda abonnemangen, och ${data.companyName} har inget betalt abonnemang just nu.`,
    'Välj ett abonnemang, så slås Peppol på automatiskt. Ni behöver inte begära det igen.',
    `Du får det här mejlet för att du begärde Peppol i ${appName}.`,
  ]
}

/**
 * Plain and short: what was asked, why it is not on, the one thing to do and
 * the way there, with the URL in clear text beside the button. Swedish only,
 * like the other mails a company's own people get about their account.
 */
export function generatePeppolPlanRequiredEmailHtml(data: PeppolPlanRequiredEmailData): string {
  const url = escapeHtml(data.billingUrl)
  const [lead, step, why] = paragraphs(data).map(escapeHtml)
  return `<!DOCTYPE html>
<html lang="sv">
<body style="margin: 0; padding: 24px; font-family: ${SANS}; color: #111; line-height: 1.5;">
  <div style="max-width: 560px; margin: 0 auto;">
    <h1 style="font-size: 20px; margin: 0 0 16px 0;">Peppol kräver ett betalt abonnemang</h1>
    <p style="margin: 0 0 16px 0;">${lead}</p>
    <p style="margin: 0 0 24px 0;">${step}</p>
    <p style="margin: 0 0 24px 0;">
      <a href="${url}" style="display: inline-block; padding: 10px 18px; background: #111; color: #fff; text-decoration: none; border-radius: 6px;">Välj abonnemang</a>
    </p>
    <p style="margin: 0 0 24px 0; color: #666; font-size: 13px;">${url}</p>
    <p style="margin: 0; color: #666; font-size: 13px;">${why}</p>
  </div>
</body>
</html>`
}

export function generatePeppolPlanRequiredEmailText(data: PeppolPlanRequiredEmailData): string {
  const [lead, step, why] = paragraphs(data)
  return [lead, '', step, '', `Välj abonnemang: ${data.billingUrl}`, '', why].join('\n')
}
