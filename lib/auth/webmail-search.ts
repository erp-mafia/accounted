/**
 * Webmail deep links for the "check your email" screen after signup or
 * password reset. Mirrors Stripe's pattern: detect the user's webmail
 * provider from the email domain and link straight to their inbox, with
 * a `from:<sender>` search pre-populated where supported (Gmail).
 *
 * Custom domains (Google Workspace, Microsoft 365, Fastmail, etc.) can't
 * be detected from the address alone — callers should fall back to the
 * plain "check your inbox" copy when this returns null.
 */

export type WebmailProviderId = 'gmail' | 'outlook' | 'yahoo' | 'icloud' | 'proton'

export interface WebmailHint {
  id: WebmailProviderId
  /** Display name, e.g. "Gmail". Not translated — provider names are global brands. */
  name: string
  /** URL that opens the user's inbox, ideally pre-populated with a from: search. */
  url: string
  /** True when the URL pre-populates a search for the sender (Gmail only today). */
  hasSearch: boolean
}

const DOMAIN_TO_PROVIDER: Record<string, WebmailProviderId> = {
  // Google free tier
  'gmail.com': 'gmail',
  'googlemail.com': 'gmail',

  // Microsoft free tier
  'outlook.com': 'outlook',
  'outlook.co.uk': 'outlook',
  'outlook.se': 'outlook',
  'hotmail.com': 'outlook',
  'hotmail.co.uk': 'outlook',
  'hotmail.se': 'outlook',
  'live.com': 'outlook',
  'live.se': 'outlook',
  'msn.com': 'outlook',

  // Yahoo
  'yahoo.com': 'yahoo',
  'yahoo.co.uk': 'yahoo',
  'yahoo.se': 'yahoo',
  'ymail.com': 'yahoo',
  'rocketmail.com': 'yahoo',

  // Apple
  'icloud.com': 'icloud',
  'me.com': 'icloud',
  'mac.com': 'icloud',

  // Proton
  'proton.me': 'proton',
  'protonmail.com': 'proton',
  'protonmail.ch': 'proton',
  'pm.me': 'proton',
}

const PROVIDER_NAMES: Record<WebmailProviderId, string> = {
  gmail: 'Gmail',
  outlook: 'Outlook',
  yahoo: 'Yahoo Mail',
  icloud: 'iCloud Mail',
  proton: 'Proton Mail',
}

function extractDomain(email: string): string | null {
  const at = email.lastIndexOf('@')
  if (at === -1) return null
  const domain = email.slice(at + 1).trim().toLowerCase()
  return domain || null
}

export function detectWebmailHint(email: string, fromAddress: string): WebmailHint | null {
  const domain = extractDomain(email)
  if (!domain) return null
  const id = DOMAIN_TO_PROVIDER[domain]
  if (!id) return null

  const name = PROVIDER_NAMES[id]

  switch (id) {
    case 'gmail': {
      // Hash-based search that survives client-side routing — the URL Stripe uses.
      const query = encodeURIComponent(`from:${fromAddress}`)
      return {
        id,
        name,
        url: `https://mail.google.com/mail/u/0/#search/${query}`,
        hasSearch: true,
      }
    }

    case 'outlook':
      // Outlook's URL-based search has shifted between OWA / Outlook.com / Office
      // and no single deep link is reliable across all account types. Open the
      // inbox so the user can locate the email themselves.
      return {
        id,
        name,
        url: 'https://outlook.live.com/mail/0/inbox',
        hasSearch: false,
      }

    case 'yahoo':
      return {
        id,
        name,
        url: 'https://mail.yahoo.com/',
        hasSearch: false,
      }

    case 'icloud':
      return {
        id,
        name,
        url: 'https://www.icloud.com/mail/',
        hasSearch: false,
      }

    case 'proton':
      return {
        id,
        name,
        url: 'https://mail.proton.me/',
        hasSearch: false,
      }
  }
}
