import { getBranding } from '@/lib/branding/service'
import { formatDateLong } from '@/lib/utils'

/**
 * The switch campaign's mails: the announcement (once per company), the
 * reminder (at 14, 7, 3 and 1 days before the deadline) and the sunset mail
 * on the day the old feed stops, the first day after the deadline (once:
 * from today the old connection fetches nothing). Swedish, short, what to
 * do: one button to the switch, a line that the history is kept, the
 * deadline, and for a byrå-managed company the note that the client's own
 * BankID is what signs the switch. A company whose banks the new provider
 * does not reach gets `uncovered` instead, once: the feed ends on the
 * deadline and the bank statement is imported as a file from then on.
 * Same calm chrome as the consent expiry mail (lib/email/consent-
 * notification-templates.ts): no red, the destination URL in plain text
 * beside the button, signed by the app.
 */

export type BankSwitchEmailKind = 'announcement' | 'reminder' | 'sunset' | 'uncovered'

export interface BankSwitchEmailData {
  kind: BankSwitchEmailKind
  /** The banks still to switch (for `uncovered`, the banks the new provider does not reach), as their Enable Banking rows name them. */
  bankNames: string[]
  /** For a switch mail: the company's other banks, the ones the new provider does not reach (their path is the file import). */
  uncoveredBankNames?: string[]
  /** The campaign deadline (ISO date). */
  deadline: string
  /** Whole days to the deadline; negative once it has passed. */
  daysLeft: number
  /** Where the switch is done: the connection's deep link, or Kopplingar when several banks wait; for `uncovered`, the bank file import. */
  switchUrl: string
  /** The company the connection belongs to; shown so the recipient knows which one, never used as the sender. */
  companyName: string
  /** The company is a byrå's client: the switch still needs the client's own BankID. */
  byraManaged: boolean
}

const SERIF = `Georgia, 'Times New Roman', serif`
const SANS = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** "Swedbank", "Swedbank och SEB", "Swedbank, SEB och Nordea". */
export function joinBankNames(names: readonly string[]): string {
  const clean = names.map((n) => n.trim()).filter(Boolean)
  if (clean.length === 0) return 'banken'
  if (clean.length === 1) return clean[0]
  return `${clean.slice(0, -1).join(', ')} och ${clean[clean.length - 1]}`
}

function dagar(n: number): string {
  return `${n} ${n === 1 ? 'dag' : 'dagar'}`
}

interface Lines {
  title: string
  intro: string
  howTo: string
  /** The company's banks the new provider does not reach, in a switch mail: their file import. */
  uncovered: string | null
  history: string
  byra: string | null
  button: string
  /** The deadline row's label. */
  dateLabel: string
  /** Where else the page is, after the button's URL. */
  elsewhere: string
}

const HISTORY = 'Historiken behålls: redan hämtade transaktioner, kontona och bokföringen påverkas inte.'

/** The mail to a company whose banks the new provider does not reach: the feed ends on the deadline, then the file import. */
function uncoveredLines(data: BankSwitchEmailData): Lines {
  const banks = joinBankNames(data.bankNames)
  const several = data.bankNames.length > 1
  const date = formatDateLong(data.deadline, 'sv')
  return {
    title: `${several ? 'Kopplingarna' : 'Kopplingen'} till ${banks} slutar hämta transaktioner ${date}`,
    intro: `Transaktionerna från ${banks} hämtas i dag genom en leverantör vi slutar använda, och den nya leverantören når inte ${several ? 'de bankerna' : 'banken'} än. Efter ${date} hämtas inga nya transaktioner därifrån.`,
    howTo: `Så gör du: ladda ner kontoutdraget från ${banks} som fil (CSV eller camt) och importera det under Importera, Bankfil. Välj samma bokföringskonto som i dag, så känns redan hämtade transaktioner igen.`,
    uncovered: null,
    history: HISTORY,
    byra: null,
    button: 'Importera bankfil',
    dateLabel: 'Hämtas till',
    elsewhere: 'Du kan också logga in som vanligt och gå till Importera och sedan Bankfil.',
  }
}

function lines(data: BankSwitchEmailData): Lines {
  if (data.kind === 'uncovered') return uncoveredLines(data)
  const banks = joinBankNames(data.bankNames)
  const several = data.bankNames.length > 1
  const date = formatDateLong(data.deadline, 'sv')
  const passed = data.daysLeft < 0
  const koppling = several ? 'bankkopplingarna' : 'bankkopplingen'
  const uncoveredBanks = (data.uncoveredBankNames ?? []).map((n) => n.trim()).filter(Boolean)

  let title: string
  let intro: string
  if (data.kind === 'sunset') {
    title = `Från i dag hämtar den gamla kopplingen inga transaktioner`
    intro = `Den tidigare leverantören av ${koppling} till ${banks} har stängts, så inga nya transaktioner hämtas förrän banken är kopplad igen genom den nya. Koppla banken igen så fortsätter hämtningen, och det som hänt sedan stoppet hämtas ikapp.`
  } else if (passed) {
    title = `Hämtningen från ${banks} har stoppats`
    intro = `Den tidigare leverantören har stängts och inga nya transaktioner hämtas från ${banks}. Koppla banken igen så fortsätter hämtningen, och det som hänt sedan stoppet hämtas ikapp.`
  } else if (data.kind === 'announcement') {
    title = `${several ? 'Bankkopplingarna' : 'Bankkopplingen'} till ${banks} byter leverantör`
    intro = `Transaktionerna från ${banks} hämtas i dag genom en leverantör vi slutar använda. Senast ${date} behöver du koppla banken igen genom den nya. Gör du det inte stannar hämtningen den dagen.`
  } else {
    title = `Påminnelse: byt ${koppling} till ${banks} senast ${date}`
    intro =
      data.daysLeft === 0
        ? `Bytet av ${koppling} till ${banks} är inte gjort än, och i dag är sista dagen. Efter i dag hämtas inga nya transaktioner förrän banken är kopplad igen.`
        : `Bytet av ${koppling} till ${banks} är inte gjort än. Det är ${dagar(data.daysLeft)} kvar till ${date}; efter det hämtas inga nya transaktioner förrän banken är kopplad igen.`
  }

  return {
    title,
    intro,
    howTo: `Så gör du: öppna länken nedan, välj Byt till ny koppling och signera med BankID hos banken. Det tar cirka två minuter${several ? ' per bank' : ''}.`,
    uncovered:
      uncoveredBanks.length === 0
        ? null
        : passed
          ? `${joinBankNames(uncoveredBanks)} nås inte av den nya leverantören: importera kontoutdrag därifrån som fil under Importera, Bankfil.`
          : `${joinBankNames(uncoveredBanks)} nås inte av den nya leverantören: efter ${date} importerar du kontoutdrag därifrån som fil under Importera, Bankfil.`,
    history: HISTORY,
    byra: data.byraManaged
      ? 'Bytet signeras med BankID av någon som har behörighet till företagets konton hos banken, så det behöver göras av er på företaget, inte av byrån.'
      : null,
    button: several ? 'Byt bankkopplingarna' : 'Byt bankkoppling',
    dateLabel: 'Senast',
    elsewhere: 'Du kan också logga in som vanligt och gå till Inställningar och sedan Kopplingar.',
  }
}

export function generateBankSwitchEmailSubject(data: BankSwitchEmailData): string {
  const suffix = data.companyName ? ` - ${data.companyName}` : ''
  return `${lines(data).title}${suffix}`
}

export function generateBankSwitchEmailHtml(data: BankSwitchEmailData): string {
  const { appName, supportEmail } = getBranding()
  const l = lines(data)
  const banks = escapeHtml(joinBankNames(data.bankNames))
  const companyName = escapeHtml(data.companyName)
  const date = formatDateLong(data.deadline, 'sv')
  const url = escapeHtml(data.switchUrl)

  return `
<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(l.title)}</title>
</head>
<body style="margin: 0; padding: 0; font-family: ${SANS}; line-height: 1.6; color: #374151; background-color: #f5f4f1;">
  <div style="max-width: 560px; margin: 0 auto; padding: 40px 20px;">
    <div style="background: #ffffff; border: 1px solid #e7e5e0; border-radius: 12px; padding: 40px;">

      <div style="font-family: ${SERIF}; font-size: 19px; color: #111111; margin-bottom: 28px;">
        ${escapeHtml(appName)}
      </div>

      <h1 style="margin: 0 0 16px 0; font-family: ${SERIF}; font-size: 23px; font-weight: 400; color: #111111; line-height: 1.3;">
        ${escapeHtml(l.title)}
      </h1>

      <p style="margin: 0 0 14px 0; font-size: 15px;">${escapeHtml(l.intro)}</p>
      <p style="margin: 0 0 14px 0; font-size: 15px;">${escapeHtml(l.howTo)}</p>
      ${l.uncovered ? `<p style="margin: 0 0 14px 0; font-size: 15px;">${escapeHtml(l.uncovered)}</p>` : ''}
      <p style="margin: 0 0 ${l.byra ? '14px' : '28px'} 0; font-size: 15px;">${escapeHtml(l.history)}</p>
      ${l.byra ? `<p style="margin: 0 0 28px 0; font-size: 15px;">${escapeHtml(l.byra)}</p>` : ''}

      <table role="presentation" style="width: 100%; border-collapse: collapse; margin-bottom: 28px; font-size: 14px;">
        <tr>
          <td style="padding: 8px 0; border-top: 1px solid #ececea; color: #9ca3af; width: 90px;">Bank</td>
          <td style="padding: 8px 0; border-top: 1px solid #ececea; color: #111111;">${banks}</td>
        </tr>
        ${companyName ? `
        <tr>
          <td style="padding: 8px 0; border-top: 1px solid #ececea; color: #9ca3af;">Företag</td>
          <td style="padding: 8px 0; border-top: 1px solid #ececea; color: #111111;">${companyName}</td>
        </tr>
        ` : ''}
        <tr>
          <td style="padding: 8px 0; border-top: 1px solid #ececea; border-bottom: 1px solid #ececea; color: #9ca3af;">${escapeHtml(l.dateLabel)}</td>
          <td style="padding: 8px 0; border-top: 1px solid #ececea; border-bottom: 1px solid #ececea; color: #111111;">${date}</td>
        </tr>
      </table>

      <div style="margin-bottom: 12px;">
        <a href="${url}" style="display: inline-block; background: #1a1a1a; color: #ffffff; padding: 12px 26px; border-radius: 99px; text-decoration: none; font-weight: 500; font-size: 14px;">
          ${escapeHtml(l.button)}
        </a>
      </div>

      <p style="margin: 0 0 32px 0; font-size: 13px; color: #9ca3af;">
        Knappen leder till ${url}.<br>
        ${escapeHtml(l.elsewhere)}
      </p>

      <div style="padding-top: 20px; border-top: 1px solid #ececea;">
        <p style="margin: 0 0 12px 0; font-size: 14px; color: #374151;">
          Med vänliga hälsningar,<br>
          <strong>${escapeHtml(appName)}</strong>
        </p>
        <p style="margin: 0; font-size: 12.5px; color: #9ca3af;">
          Du får det här mejlet eftersom det finns en bankkoppling i ${escapeHtml(appName)}${companyName ? ` för ${companyName}` : ''}.
          Undrar du något? Mejla <a href="mailto:${escapeHtml(supportEmail)}" style="color: #6b7280;">${escapeHtml(supportEmail)}</a>.
        </p>
      </div>
    </div>
  </div>
</body>
</html>
`
}

export function generateBankSwitchEmailText(data: BankSwitchEmailData): string {
  const { appName, supportEmail } = getBranding()
  const l = lines(data)
  const date = formatDateLong(data.deadline, 'sv')

  let text = `${l.title}\n\n`
  text += `${l.intro}\n\n`
  text += `${l.howTo}\n\n`
  if (l.uncovered) text += `${l.uncovered}\n\n`
  text += `${l.history}\n\n`
  if (l.byra) text += `${l.byra}\n\n`
  text += `Bank: ${joinBankNames(data.bankNames)}\n`
  if (data.companyName) text += `Företag: ${data.companyName}\n`
  text += `${l.dateLabel}: ${date}\n`
  text += `\n${l.button}: ${data.switchUrl}\n`
  text += `${l.elsewhere}\n\n`
  text += `Med vänliga hälsningar,\n`
  text += `${appName}\n\n`
  text += `Du får det här mejlet eftersom det finns en bankkoppling i ${appName}${data.companyName ? ` för ${data.companyName}` : ''}. Undrar du något? Mejla ${supportEmail}.\n`
  return text
}
