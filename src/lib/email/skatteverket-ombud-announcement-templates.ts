import { escapeHtml } from '@/lib/email/signing-mail-layout'
import type { MailLogo } from '@/lib/signing/logo'

/**
 * The one-time mail telling a company's owners and admins that they can now
 * appoint the app as ombud at Skatteverket (the cron in
 * extensions/general/skatteverket/lib/ombud-announcement.ts). The founder's
 * own words, in the company's brand: the brand's name everywhere the app is
 * named, its logo on top, and for a white-label brand the sign-off the bank
 * switch mails use (the brand, never a person of ours). One mail per person
 * and brand, naming every company it is about.
 *
 * Step 1 names the button as the settings page labels it
 * (settings_skatteverket_connect.system_deeplink in messages/sv.json; a test
 * holds the two together), on Inställningar, Skatteverket, which shows it to
 * every company that can appoint. Hem shows a short "Anslut" instead, and only
 * while the viewing person has no BankID session, so the mail does not send
 * anyone there.
 */

export interface SkvOmbudAnnouncementData {
  /** The company's brand name, or the platform's. */
  appName: string
  /** The companies the mail is about, by name (at least one). */
  companyNames: string[]
  /** Inställningar, Skatteverket on the brand's own domain. */
  settingsUrl: string
  /** The brand's logo; null writes the app name instead. */
  logo: MailLogo | null
  /** Where questions go: the brand's support address, or the platform's. */
  supportEmail: string
  /** 'founder' signs //Emil (the platform's own mail); 'brand' signs with the brand name. */
  signature: 'founder' | 'brand'
}

export const SKV_OMBUD_ANNOUNCEMENT_SUBJECT = 'Nu slipper du logga in med BankID för skattekontot'

/** The settings button as the page labels it (settings_skatteverket_connect.system_deeplink). */
export function ombudButtonLabel(appName: string): string {
  return `Utse ${appName} som ombud för företaget`
}

const SERIF = `Georgia, 'Times New Roman', serif`
const SANS = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`

/** "A", "A och B", "A, B och C". */
function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} och ${names[names.length - 1]}`
}

interface Lines {
  intro: string
  companies: string
  stepsLead: string
  steps: string[]
  button: string
  wait: string
  declarations: string
  shout: string
  why: string
}

function lines(data: SkvOmbudAnnouncementData): Lines {
  const { appName } = data
  const names = data.companyNames.map((n) => n.trim()).filter(Boolean)
  const several = names.length > 1
  return {
    intro: `Nu kan du utse ${appName} som ombud för ditt företag hos Skatteverket. Då hämtar vi skattekontot och momsens status automatiskt, utan att du behöver logga in med BankID varje gång.`,
    companies: several
      ? `Det gäller ${joinNames(names)}. Gör stegen nedan för ett företag i taget och välj först företaget i ${appName}.`
      : names.length === 1
        ? `Det gäller ${names[0]}.`
        : '',
    stepsLead: 'Så gör du (tar ett par minuter):',
    steps: [
      `Öppna Inställningar och sedan Skatteverket i ${appName} (knappen nedan tar dig dit) och klicka på "${ombudButtonLabel(appName)}".`,
      'Du skickas till Skatteverket. Företagets firmatecknare (i enskild firma ägaren) loggar in med BankID.',
      '"Skattekonto, bara läsbehörighet" och "Momsdeklaration, ombud" är redan ikryssade. Låt dem vara kvar.',
      'Signera hela vägen tills du får Skatteverkets kvittens.',
    ],
    button: `Öppna Skatteverket i ${appName}`,
    wait: `Det tar några minuter, ibland upp till en timme, innan Skatteverket har registrerat oss. ${appName} kollar automatiskt och visar när det är klart.`,
    declarations: 'Deklarationer signerar du som vanligt själv med BankID.',
    shout: 'Hojta om något strular!',
    why: several
      ? `Du får det här mejlet eftersom du är ägare eller administratör för ${names.length} företag i ${appName}.`
      : `Du får det här mejlet eftersom du är ägare eller administratör för ${names[0] ?? 'ett företag'} i ${appName}.`,
  }
}

function header(data: SkvOmbudAnnouncementData): string {
  if (data.logo) {
    const { src, width, height } = data.logo
    return `<img src="${escapeHtml(src)}" width="${width}" height="${height}" alt="${escapeHtml(data.appName)}" style="display: block; width: ${width}px; height: ${height}px; border: 0; outline: none; text-decoration: none;">`
  }
  return `<div style="font-family: ${SERIF}; font-size: 19px; color: #111111;">${escapeHtml(data.appName)}</div>`
}

export function generateSkvOmbudAnnouncementHtml(data: SkvOmbudAnnouncementData): string {
  const l = lines(data)
  const p = (text: string, margin = '14px') => `<p style="margin: 0 0 ${margin} 0; font-size: 15px;">${escapeHtml(text)}</p>`
  const url = escapeHtml(data.settingsUrl)
  const signature =
    data.signature === 'founder'
      ? `<p style="margin: 0 0 28px 0; font-size: 15px; color: #111111;">//Emil</p>`
      : `<p style="margin: 0 0 28px 0; font-size: 15px; color: #374151;">Med vänliga hälsningar,<br><strong>${escapeHtml(data.appName)}</strong></p>`

  return `
<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(SKV_OMBUD_ANNOUNCEMENT_SUBJECT)}</title>
</head>
<body style="margin: 0; padding: 0; font-family: ${SANS}; line-height: 1.6; color: #374151; background-color: #f5f4f1;">
  <div style="max-width: 560px; margin: 0 auto; padding: 40px 20px;">
    <div style="background: #ffffff; border: 1px solid #e7e5e0; border-radius: 12px; padding: 40px;">

      <div style="margin-bottom: 28px;">${header(data)}</div>

      ${p('Hej!')}
      ${p(l.intro)}
      ${l.companies ? p(l.companies) : ''}

      <p style="margin: 0 0 8px 0; font-size: 15px;">${escapeHtml(l.stepsLead)}</p>
      <ol style="margin: 0 0 24px 0; padding-left: 22px; font-size: 15px;">
        ${l.steps.map((step) => `<li style="margin: 0 0 6px 0;">${escapeHtml(step)}</li>`).join('\n        ')}
      </ol>

      <div style="margin-bottom: 12px;">
        <a href="${url}" style="display: inline-block; background: #1a1a1a; color: #ffffff; padding: 12px 26px; border-radius: 99px; text-decoration: none; font-weight: 500; font-size: 14px;">
          ${escapeHtml(l.button)}
        </a>
      </div>
      <p style="margin: 0 0 24px 0; font-size: 13px; color: #9ca3af; word-break: break-all;">Knappen leder till ${url}.</p>

      ${p(l.wait)}
      ${p(l.declarations)}
      ${p(l.shout, '20px')}
      ${signature}

      <div style="padding-top: 20px; border-top: 1px solid #ececea;">
        <p style="margin: 0; font-size: 12.5px; color: #9ca3af;">
          ${escapeHtml(l.why)}
          Undrar du något? Svara på mejlet eller mejla <a href="mailto:${escapeHtml(data.supportEmail)}" style="color: #6b7280;">${escapeHtml(data.supportEmail)}</a>.
        </p>
      </div>
    </div>
  </div>
</body>
</html>
`
}

export function generateSkvOmbudAnnouncementText(data: SkvOmbudAnnouncementData): string {
  const l = lines(data)
  let text = 'Hej!\n\n'
  text += `${l.intro}\n\n`
  if (l.companies) text += `${l.companies}\n\n`
  text += `${l.stepsLead}\n`
  l.steps.forEach((step, i) => {
    text += `${i + 1}. ${step}\n`
  })
  text += `\n${l.button}: ${data.settingsUrl}\n\n`
  text += `${l.wait}\n\n`
  text += `${l.declarations}\n\n`
  text += `${l.shout}\n\n`
  text += data.signature === 'founder' ? '//Emil\n\n' : `Med vänliga hälsningar,\n${data.appName}\n\n`
  text += `${l.why} Undrar du något? Svara på mejlet eller mejla ${data.supportEmail}.\n`
  return text
}
