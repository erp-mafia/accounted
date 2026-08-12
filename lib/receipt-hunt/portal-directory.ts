/**
 * Where a supplier keeps its invoices, when it does not send them.
 *
 * Some vendors never attach anything. They mail "your invoice is ready", or
 * nothing at all, and the invoice waits behind a login. Presto built a business
 * on logging in for you, across a thousand portals, with a desktop app so the
 * credentials never leave the machine. We deliberately do not: holding a
 * customer's supplier passwords is the expensive and legally heavy half of that
 * product, and skipping it costs little of the value.
 *
 * What is left is knowing *where*. Seeing "OPENAI  CHATGPT SUBSCR" on a
 * statement is enough to say which page the invoice is on, and that turns a
 * dead end into a one-click errand.
 *
 * The lookup happens at read time and nothing is stored against a transaction.
 * Adding an entry therefore fixes every ledger at once, retroactively, with no
 * migration and no backfill: a supplier someone adds today starts answering for
 * purchases made last year.
 *
 * ## What belongs here
 *
 * A vendor whose invoice a human can fetch from a stable page. Not payment
 * types that have no invoice at all: tax, salary, bank fees. The hunt already
 * refuses to search mail for those, and offering a link would be worse than
 * silence.
 *
 * ## Entries are unverified until someone checks them
 *
 * A wrong URL is worse than a missing one: it sends somebody to a page that
 * cannot help and spends the trust the feature runs on. These were chosen for
 * having a stable, well-known billing page, and each still deserves a human
 * clicking it. Vendors whose billing page could not be pinned down were left
 * out rather than guessed at.
 */
import { normalizeForMatch } from '@/lib/documents/core-receipt-matcher'
import { canHaveEmailReceipt } from './select'

export interface PortalEntry {
  /** How the vendor calls itself, for the interface to show. */
  vendor: string
  /**
   * Fragments of a bank descriptor, already folded the way the matcher folds
   * them: lowercase, no card tokens, no payment rails. A match on any one is
   * a match on the vendor.
   */
  aliases: string[]
  /** The page a person lands on to fetch the invoice. */
  url: string
  /** What they will find there, when it is not obvious. */
  note?: string
}

/**
 * Ordered by how many companies actually pay them, measured across production
 * ledgers, cross-checked against a customer poll.
 *
 * The bar is "does not send the invoice", not "also has a portal". Almost every
 * vendor here has a billing page; what earns an entry is that the invoice does
 * not arrive by mail, so a person has no other way to get it.
 *
 * Anthropic, Vercel and Supabase were removed after a founder pointed out that
 * all three do email their invoices, at least to European customers. The poll
 * they came from asked which portals people log into, and people answered with
 * where the invoice can ALSO be found. Listing them told somebody to go and log
 * in for a document already sitting in their inbox, which is worse than saying
 * nothing: it sends them away from the answer.
 *
 * The same objection may reach further down this list. An entry is a claim that
 * the invoice cannot be had any other way, and that claim is worth checking per
 * vendor rather than assuming.
 *
 * ## The URLs were wrong, and shipped anyway
 *
 * Every path here was hand-written and none was opened. The file said so and
 * shipped regardless, and a founder then hit a 404 on Google Workspace. A
 * subsequent HTTP sweep found GitHub's billing path 404 as well. Both are
 * corrected; Trygg Hansa was removed because neither of its candidate URLs
 * could be reached at all, and an unverifiable link is the same promise this
 * comment keeps warning about.
 *
 * Prefer the shallowest URL that certainly resolves. A link landing one click
 * short of the invoice is a small cost; one landing on an error page spends
 * the trust the whole feature runs on. Several hosts here (Google, OpenAI,
 * Hetzner) refuse an automated request, so they cannot be swept: those stay
 * shallow on purpose.
 */
export const PORTAL_DIRECTORY: PortalEntry[] = [
  {
    vendor: 'Google Workspace',
    aliases: ['google workspace', 'google gsuite', 'google apps'],
    // The console root, not a deep billing path. /ac/billing/history returned
    // a 404 in a real browser, and admin.google.com blocks the checker, so no
    // deeper path can be verified from here. The root certainly resolves and
    // billing is one click from it; a link that lands slightly short beats one
    // that lands on an error page.
    url: 'https://admin.google.com',
    note: 'Fakturor ligger under Fakturering i adminkonsolen.',
  },
  {
    vendor: 'Google Cloud',
    aliases: ['google cloud', 'google svcs', 'gcp'],
    url: 'https://console.cloud.google.com/billing',
  },
  {
    vendor: 'OpenAI',
    aliases: ['openai', 'chatgpt'],
    url: 'https://platform.openai.com/settings/organization/billing/history',
  },
  {
    vendor: 'Microsoft 365',
    aliases: ['microsoft', 'msft', 'office 365'],
    url: 'https://admin.microsoft.com/#/billing/bills-payments/invoices',
  },
  {
    vendor: 'Microsoft Azure',
    aliases: ['azure'],
    url: 'https://portal.azure.com',
    note: 'Kostnadshantering och fakturering.',
  },
  {
    vendor: 'Amazon Web Services',
    aliases: ['amazon web', 'aws emea', 'aws europe'],
    url: 'https://console.aws.amazon.com/billing/home#/bills',
  },
  {
    vendor: 'Adobe',
    aliases: ['adobe'],
    url: 'https://account.adobe.com/plans',
  },
  {
    vendor: 'Meta Ads',
    aliases: ['meta platforms', 'facebook ads', 'facebk'],
    url: 'https://business.facebook.com/billing_hub/accounts',
  },
  {
    vendor: 'LinkedIn Ads',
    aliases: ['linkedin'],
    url: 'https://www.linkedin.com/campaignmanager/accounts',
    note: 'Fakturor under Billing center i Campaign Manager.',
  },
  {
    vendor: 'Atlassian',
    aliases: ['atlassian', 'jira', 'confluence'],
    url: 'https://admin.atlassian.com/billing',
  },
  {
    vendor: 'Hetzner',
    aliases: ['hetzner'],
    url: 'https://accounts.hetzner.com/invoice',
  },
  {
    vendor: 'GitHub',
    aliases: ['github'],
    url: 'https://github.com/settings/billing/summary',
  },
  {
    vendor: 'Cursor',
    aliases: ['cursor ai', 'cursor com'],
    url: 'https://cursor.com/settings',
  },
  {
    vendor: 'Loopia',
    aliases: ['loopia'],
    url: 'https://customerzone.loopia.se',
  },
]

/**
 * Which supplier a bank descriptor refers to, when we know where its invoices
 * live.
 *
 * The descriptor is folded first, so "ANTHROPIC* CLAUDE SUB SAN FRANCISCO" and
 * "Kortköp 260228 HETZNER ONLINE GMBH" resolve like anything else the matcher
 * reads. Longer aliases are tried first: "google cloud" must win over a
 * hypothetical bare "google", or a cloud bill would point at Workspace.
 */
export function lookupPortal(descriptor: string | null | undefined): PortalEntry | null {
  if (!descriptor) return null

  // A salary run or a tax payment has no invoice to fetch, and sending someone
  // to a portal for one is worse than saying nothing.
  if (!canHaveEmailReceipt(descriptor)) return null

  const folded = normalizeForMatch(descriptor)
  if (!folded) return null

  let best: PortalEntry | null = null
  let bestLength = 0
  for (const entry of PORTAL_DIRECTORY) {
    for (const alias of entry.aliases) {
      if (alias.length > bestLength && folded.includes(alias)) {
        best = entry
        bestLength = alias.length
      }
    }
  }
  return best
}
