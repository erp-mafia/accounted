/**
 * Cookbook recipe registry. All six recipes ship live as of Phase 6 PR-3:
 *   - quickstart: send your first invoice (high-leverage onboarding path)
 *   - webhooks: end-to-end webhook setup with sig verification + retry handling
 *   - ingest-bank-transactions: bank file → categorised + invoice-matched
 *   - file-vat-declaration: compute rutor 05-62, reconcile against GL,
 *     manual submission to Skatteverket (includes 2026-04-01 livsmedel
 *     12% → 6% rate-change transition)
 *   - run-payroll-and-agi: draft → calculate → approve → mark-paid →
 *     book → generate-agi state machine
 *   - year-end-closing: IB/UB continuity per BFL 5 kap, year-end procedures,
 *     irreversible close per BFL 5 kap 8 §
 */

import { QUICKSTART_MD } from './quickstart'
import { COOKBOOK_WEBHOOKS_MD } from './webhooks'
import { COOKBOOK_INGEST_BANK_MD } from './ingest-bank-transactions'
import { COOKBOOK_VAT_DECLARATION_MD } from './file-vat-declaration'
import { COOKBOOK_PAYROLL_AGI_MD } from './run-payroll-and-agi'
import { COOKBOOK_YEAR_END_MD } from './year-end-closing'

interface CookbookEntry {
  slug: string
  title: string
  /** Full markdown content, OR null if the recipe is a placeholder. */
  markdown: string | null
  /** Where the placeholder points the reader if markdown is null. */
  referenceLink?: { href: string; label: string }
  description: string
}

export const COOKBOOK: CookbookEntry[] = [
  {
    slug: 'quickstart',
    title: 'Quickstart: send your first invoice',
    markdown: QUICKSTART_MD,
    description: 'Five minutes from a fresh sandbox to an emailed invoice.',
  },
  {
    slug: 'send-first-invoice',
    title: 'Send your first invoice',
    markdown: QUICKSTART_MD, // alias of quickstart for now
    description: 'Create a customer, draft an invoice, send it, mark it paid.',
  },
  {
    slug: 'webhooks',
    title: 'Set up webhooks and verify signatures',
    markdown: COOKBOOK_WEBHOOKS_MD,
    description: 'Subscribe to events, verify HMAC, handle retries idempotently.',
  },
  {
    slug: 'set-up-webhooks-and-verify-signatures',
    title: 'Set up webhooks and verify signatures',
    markdown: COOKBOOK_WEBHOOKS_MD, // alias matching docs nav
    description: 'Subscribe to events, verify HMAC, handle retries idempotently.',
  },
  {
    slug: 'ingest-bank-transactions',
    title: 'Ingest and categorise bank transactions',
    markdown: COOKBOOK_INGEST_BANK_MD,
    description: 'Push CSV/CAMT into the engine, get AI suggestions, commit, match payments.',
  },
  {
    slug: 'file-vat-declaration',
    title: 'Compute and review a VAT declaration',
    markdown: COOKBOOK_VAT_DECLARATION_MD,
    description: 'Compute momsdeklaration rutor 05-62 and reconcile against the GL before manual submission to Skatteverket. Includes the 2026-04-01 livsmedel 12% → 6% rate-change transition.',
  },
  {
    slug: 'run-payroll-and-agi',
    title: 'Run payroll and generate the AGI XML',
    markdown: COOKBOOK_PAYROLL_AGI_MD,
    description: 'Calculate, approve, mark paid, book, generate the AGI XML for manual submission to Skatteverket Mina Sidor.',
  },
  {
    slug: 'year-end-closing',
    title: 'Year-end closing',
    markdown: COOKBOOK_YEAR_END_MD,
    description: 'Lock periods, run year-end procedures, set opening balances. IB/UB continuity per BFL 5 kap.',
  },
]

export function findRecipe(slug: string): CookbookEntry | undefined {
  return COOKBOOK.find((c) => c.slug === slug)
}

export const COOKBOOK_SLUGS = COOKBOOK.map((c) => c.slug)

export function buildPlaceholderMd(entry: CookbookEntry): string {
  const link = entry.referenceLink
  return [
    `# ${entry.title}`,
    '',
    `> ${entry.description}`,
    '',
    '## Coming soon',
    '',
    `This narrative cookbook recipe is in the queue alongside the Phase 6 PR-3 hardening work. The endpoints are live and documented: start from the [reference page](${link?.href ?? '/docs/api/reference'}) below and the [quickstart](/docs/api/cookbook/quickstart) for the auth + idempotency + dry-run patterns; the recipe will be a guided narrative on top.`,
    '',
    link
      ? `**Reference:** [${link.label}](${link.href})`
      : '**Reference:** [API reference](/docs/api/reference)',
    '',
    '**Related cookbooks already shipped:**',
    '',
    '- [Quickstart: send your first invoice](/docs/api/cookbook/quickstart)',
    '- [Set up webhooks and verify signatures](/docs/api/cookbook/webhooks)',
  ].join('\n')
}
