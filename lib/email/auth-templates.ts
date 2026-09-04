/**
 * Auth mail templates for the Supabase Send Email hook (WL-05, WL-13).
 *
 * Swedish-only, like the other user-facing mail templates in lib/email/
 * (see .claude/rules/i18n.md): these are transactional mails, not UI chrome,
 * so they deliberately do not go through next-intl.
 *
 * The appName parameter carries the brand of the requesting host (resolved
 * via resolveBrandByHost from the redirect_to origin); the default is the
 * platform name, so unbranded hosts render canonical mail.
 */

import { escapeHtml, sanitizeSubjectLine } from './user-text'

export type AuthEmailActionType =
  | 'signup'
  | 'recovery'
  | 'magiclink'
  | 'invite'
  | 'email_change'
  | 'email_change_current'
  | 'reauthentication'
  | 'bankid_signup'

interface AuthEmailContent {
  subject: string
  heading: string
  body: (appName: string) => string
  cta: string
}

const CONTENT: Record<AuthEmailActionType, AuthEmailContent> = {
  signup: {
    subject: 'Bekräfta din e-postadress',
    heading: 'Bekräfta din e-postadress',
    body: (appName) =>
      `Klicka på knappen nedan för att bekräfta din e-postadress och slutföra din registrering hos ${appName}.`,
    cta: 'Bekräfta e-postadress',
  },
  recovery: {
    subject: 'Återställ ditt lösenord',
    heading: 'Återställ ditt lösenord',
    body: (appName) =>
      `Vi har tagit emot en begäran om att återställa lösenordet för ditt konto hos ${appName}. Klicka på knappen nedan för att välja ett nytt lösenord.`,
    cta: 'Återställ lösenord',
  },
  magiclink: {
    subject: 'Din inloggningslänk',
    heading: 'Logga in',
    body: (appName) => `Klicka på knappen nedan för att logga in hos ${appName}.`,
    cta: 'Logga in',
  },
  invite: {
    subject: 'Du har blivit inbjuden',
    heading: 'Du har blivit inbjuden',
    body: (appName) =>
      `Du har blivit inbjuden till ${appName}. Klicka på knappen nedan för att skapa ditt konto.`,
    cta: 'Acceptera inbjudan',
  },
  email_change: {
    subject: 'Bekräfta din nya e-postadress',
    heading: 'Bekräfta din nya e-postadress',
    body: (appName) =>
      `Klicka på knappen nedan för att bekräfta din nya e-postadress hos ${appName}. Av säkerhetsskäl skickas två mail, ett till din nya adress och ett till din nuvarande. Bytet slutförs först när du klickat på länken i båda.`,
    cta: 'Bekräfta ny e-postadress',
  },
  email_change_current: {
    subject: 'Godkänn ändrad e-postadress',
    heading: 'Godkänn ändrad e-postadress',
    body: (appName) =>
      `En ändring av e-postadressen för ditt konto hos ${appName} har begärts. Klicka på knappen nedan för att godkänna ändringen från din nuvarande adress. Av säkerhetsskäl skickas två mail, ett till din nuvarande adress och ett till din nya. Bytet slutförs först när du klickat på länken i båda.`,
    cta: 'Godkänn ändringen',
  },
  reauthentication: {
    subject: 'Din verifieringskod',
    heading: 'Din verifieringskod',
    body: (appName) => `Ange koden nedan för att bekräfta din identitet hos ${appName}.`,
    cta: '',
  },
  // Sent by the BankID signup (extensions/general/tic) to the address the
  // person typed, and again when a still-unconfirmed identity tries to log
  // in. Not a Supabase hook type: the link is minted by generateLink and only
  // ever travels by mail. The copy says plainly that the account was opened
  // with BankID and that ignoring the mail leaves it inactive, so a stranger
  // whose address was typed by mistake (or on purpose) is not nudged into
  // activating someone else's BankID login.
  bankid_signup: {
    subject: 'Bekräfta din e-postadress',
    heading: 'Bekräfta din e-postadress',
    body: (appName) =>
      `Ett konto hos ${appName} har skapats med BankID och den här e-postadressen. Klicka på knappen nedan för att bekräfta att adressen är din och aktivera kontot. Om det inte var du som skapade kontot kan du bortse från det här meddelandet: kontot förblir inaktivt och kan inte användas för att logga in.`,
    cta: 'Bekräfta e-postadress',
  },
}

// Availability first: an action type this module does not know (Supabase can
// add new mail classes) still produces a usable mail with the verify link
// rather than dropping the send.
const FALLBACK_CONTENT: AuthEmailContent = {
  subject: 'Bekräfta din åtgärd',
  heading: 'Bekräfta din åtgärd',
  body: (appName) => `Klicka på knappen nedan för att fortsätta hos ${appName}.`,
  cta: 'Fortsätt',
}

const IGNORE_NOTE = 'Om du inte begärde detta kan du bortse från det här meddelandet.'

export interface AuthEmailInput {
  actionType: string
  appName: string
  /** Verify URL on the originating host (token_hash flow). */
  actionUrl?: string
  /** One-time code, for reauthentication mail (no link). */
  otpCode?: string
}

export interface AuthEmail {
  subject: string
  html: string
  text: string
}

function contentFor(actionType: string): AuthEmailContent {
  return (CONTENT as Record<string, AuthEmailContent>)[actionType] ?? FALLBACK_CONTENT
}

export function buildAuthEmail(input: AuthEmailInput): AuthEmail {
  const content = contentFor(input.actionType)
  const appName = input.appName
  const safeAppName = escapeHtml(appName)
  const body = content.body(appName)

  const action = input.otpCode
    ? `
      <div style="margin: 28px 0;">
        <span style="display: inline-block; background: #f5f5f5; border: 1px solid #e5e5e5; border-radius: 8px; padding: 12px 28px; font-size: 22px; font-weight: 600; letter-spacing: 0.3em; color: #111;">${escapeHtml(input.otpCode)}</span>
      </div>`
    : input.actionUrl
      ? `
      <div style="margin: 28px 0;">
        <a href="${escapeHtml(input.actionUrl)}" style="display: inline-block; background: #111; color: #fff; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-size: 14px; font-weight: 500;">
          ${escapeHtml(content.cta)}
        </a>
      </div>`
      : ''

  const html = `
<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(content.subject)}</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; background-color: #f5f5f5;">
  <div style="max-width: 520px; margin: 0 auto; padding: 40px 20px;">
    <div style="background: #ffffff; border-radius: 12px; padding: 40px 32px; border: 1px solid #e5e5e5;">
      <!-- Header -->
      <div style="margin-bottom: 28px;">
        <p style="margin: 0 0 4px 0; font-size: 13px; color: #888; letter-spacing: 0.05em;">${safeAppName.toUpperCase()}</p>
        <h1 style="margin: 0 0 8px 0; font-size: 22px; font-weight: 600; color: #111;">
          ${escapeHtml(content.heading)}
        </h1>
        <p style="margin: 0; color: #666; font-size: 15px;">
          ${escapeHtml(body)}
        </p>
      </div>
${action}
      <!-- Info -->
      <p style="margin: 0; color: #999; font-size: 13px;">
        ${IGNORE_NOTE}
      </p>
    </div>
  </div>
</body>
</html>`

  let text = `${content.heading}\n\n${body}\n\n`
  if (input.otpCode) {
    text += `Kod: ${input.otpCode}\n\n`
  } else if (input.actionUrl) {
    text += `${content.cta}: ${input.actionUrl}\n\n`
  }
  text += IGNORE_NOTE

  return {
    subject: sanitizeSubjectLine(content.subject),
    html,
    text,
  }
}
