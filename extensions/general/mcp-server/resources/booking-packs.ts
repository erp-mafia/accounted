import type { McpResource } from './types'
import { loadPacks, sortPacks } from '@/lib/packs/load'

/**
 * The konteringspaket catalogue, for agents.
 *
 * ## Why this exists
 *
 * Without it an agent proposing a booking has to invent the account numbers,
 * and a plausible-looking guess (6071 instead of 6072, or the full cost instead
 * of the 80% deductible share) produces a verifikat that posts but is wrong.
 * A named catalogue turns "here are some accounts I think apply" into "this is
 * the representation-avdragsgill-25-moms template", which the user can
 * recognise, and which carries the statutory note explaining when it applies.
 *
 * ## Read from packs, not from the database
 *
 * `legal_note` lives only in the YAML: `booking_template_library` has no column
 * for it, so the database copy cannot answer "when does this template apply".
 * That note is the most valuable field here, because it is the part an agent
 * cannot derive from account numbers.
 *
 * The catalogue is identical for every company (system templates are global),
 * so nothing here is company-scoped and no `companyId` filter applies. A
 * company's OWN templates are not included: those live in the database and are
 * reachable through the booking-template tools.
 *
 * Read on demand via resources/read, so this costs nothing in the tools/list
 * payload budget.
 */
export const bookingPacksResource: McpResource = {
  uri: 'Accounted://booking-templates',
  name: 'Booking Templates (konteringspaket)',
  // Kept within the 280-char house limit for tool descriptions. Resources are
  // not covered by that guard, but the surface reads better held to one rule.
  description:
    'Standard Swedish bookkeeping templates: which BAS accounts each posts to, on which side, and how one total amount splits across them, plus the statutory note on when each applies. Read before proposing a manual booking so you name a reviewed template instead of guessing accounts.',
  mimeType: 'application/json',
  read: async () => {
    const { packs, errors } = loadPacks()

    if (errors.length) {
      // Surface rather than silently return a partial catalogue: an agent that
      // sees 12 of 26 templates will confidently conclude the other 14 do not
      // exist and hand-roll accounts for them.
      return {
        error: 'Pack catalogue failed to load; treat this list as unavailable, not as empty.',
        details: errors.map((e) => `${e.file}: ${e.message}`),
        templates: [],
      }
    }

    return {
      templates: sortPacks(packs).map(({ pack }) => ({
        slug: pack.meta.slug,
        name: pack.meta.name,
        description: pack.meta.description,
        legal_note: pack.meta.legal_note,
        category: pack.meta.category,
        entity_type: pack.meta.entity_type,
        lines: pack.lines.map((l) => ({
          account: l.account,
          label: l.label,
          side: l.side,
          type: l.type,
          ratio: l.ratio,
          vat_rate: l.vat_rate,
        })),
      })),
      how_to_apply: {
        input: 'The user enters ONE total amount. Every line is derived from it.',
        vat_line: 'amount = total * vat_rate / (1 + vat_rate). The total is VAT-inclusive.',
        business_line: 'amount = total * ratio. The cost or revenue leg.',
        settlement_line: 'amount = total * ratio. The money leg (bank account, reskontra).',
        balance: 'Debits and credits always sum equal. If your computed lines do not balance, you have applied the template wrong: do not adjust an amount to force it.',
      },
      notes: {
        entity_type: "A template marked 'aktiebolag' or 'enskild_firma' must not be used for the other form; 'all' applies to both.",
        legal_note: 'Where present, it states the statutory limit or condition. Read it before proposing the booking: it is the difference between a template that applies and one that merely looks close.',
        accounts: 'Account numbers are strings and every one is a standard BAS 2026 account, enforced in CI. Never substitute a neighbouring number.',
        company_templates: 'This is the standard catalogue only. A company may have its own templates; those come from the booking-template tools, not from here.',
        posting: 'This resource describes templates. It does not post anything: create the entry through the journal-entry tools so period locks and the balance check apply.',
      },
    }
  },
}
