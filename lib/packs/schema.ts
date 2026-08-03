import { z } from 'zod'
import { accountNumberSchema } from '@/lib/invariants/zod'

/**
 * The konteringspaket (pack) contract.
 *
 * ## What a pack is
 *
 * One reusable bookkeeping pattern, as data: the accounts it touches, which
 * side each lands on, and how a total amount is split across them. A pack is
 * pure data forever. It never carries executable code or DDL, which is the
 * lock recorded in `dev_docs/niche_factory.md` and what makes a pack safe to
 * accept from an author who is not us.
 *
 * ## Why the catalogue moved out of a migration
 *
 * The 26 system templates were seeded inside
 * `supabase/migrations/20260413160000_booking_template_library.sql`. Under the
 * never-modify-a-shipped-migration rule that froze them: correcting a wrong BAS
 * account or a Swedish typo needed a whole new migration, and nothing checked
 * that a seeded account existed in the chart or that a template balanced. PR
 * #1321 was exactly that failure with seeded chart names. As data files with a
 * validator, a correction is a one-line edit plus a green CI run.
 *
 * ## The line model
 *
 * `applyTemplate()` in `lib/bookkeeping/template-library.ts` turns a total
 * amount into lines, and the three types are not decorative:
 *
 * - `vat`: amount is `total * vat_rate / (1 + vat_rate)`, so it carries
 *   `vat_rate` and never `ratio`.
 * - `business` and `settlement`: amount is `total * ratio`, so they carry
 *   `ratio` and never `vat_rate`.
 *
 * That split is enforced below rather than left as a convention, because a
 * `vat` line with a `ratio` silently computes the wrong amount.
 */

/** Categories a pack can be filed under. Mirrors the `booking_template_library.category` CHECK. */
export const PACK_CATEGORIES = [
  'eu_trade',
  'tax_account',
  'private_transfer',
  'salary',
  'representation',
  'year_end',
  'vat',
  'financial',
  'other',
] as const

/** Which entity types a pack applies to. Mirrors the `entity_type` CHECK. */
export const PACK_ENTITY_TYPES = ['all', 'enskild_firma', 'aktiebolag'] as const

/** Line roles. Drives the amount maths in `applyTemplate()`. */
export const PACK_LINE_TYPES = ['business', 'vat', 'settlement'] as const

/**
 * Slug: lowercase kebab-case. This is the **public lookup key**, used as the
 * filename, in the docs URL, and by the assistant to name a pack. Renaming one
 * breaks every reference, so treat it as an identifier, not a label.
 */
export const PACK_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export const PackLineSchema = z
  .object({
    // From lib/invariants: the same BAS account rule the API, the MCP surface
    // and the SIE importer use. A pack cannot disagree with the rest of the app
    // about what an account number is.
    account: accountNumberSchema,
    label: z.string().min(1).max(200),
    side: z.enum(['debit', 'credit']),
    type: z.enum(PACK_LINE_TYPES),
    ratio: z.number().min(0).max(10).optional(),
    vat_rate: z.number().min(0).max(1).optional(),
  })
  .strict()
  .superRefine((line, ctx) => {
    if (line.type === 'vat') {
      if (line.vat_rate === undefined) {
        ctx.addIssue({ code: 'custom', message: 'a vat line must carry vat_rate', path: ['vat_rate'] })
      }
      if (line.ratio !== undefined) {
        ctx.addIssue({
          code: 'custom',
          message: 'a vat line must not carry ratio: its amount comes from vat_rate',
          path: ['ratio'],
        })
      }
      return
    }
    if (line.ratio === undefined) {
      ctx.addIssue({ code: 'custom', message: `a ${line.type} line must carry ratio`, path: ['ratio'] })
    }
    if (line.vat_rate !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: `a ${line.type} line must not carry vat_rate`,
        path: ['vat_rate'],
      })
    }
  })

export const PackMetaSchema = z
  .object({
    slug: z.string().regex(PACK_SLUG_RE, 'slug must be lowercase kebab-case'),
    /**
     * Single source of truth for display order, unique across the catalogue.
     * The in-app gallery and the docs site both sort on it, so the two surfaces
     * cannot disagree. Renumber deliberately.
     */
    order: z.number().int().positive(),
    name: z.string().min(1).max(200),
    description: z.string().max(2000).default(''),
    /**
     * Optional Swedish note on the statutory rule behind the pattern, e.g. the
     * 300 kr per person cap on representation VAT. Rendered next to the pack so
     * a user knows *when* the template applies, not just what it posts.
     * Stays Swedish in both locales: it is statutory content, per
     * `.claude/rules/i18n.md`.
     */
    legal_note: z.string().max(2000).optional(),
    category: z.enum(PACK_CATEGORIES),
    entity_type: z.enum(PACK_ENTITY_TYPES).default('all'),
  })
  .strict()

export const PackSchema = z
  .object({
    meta: PackMetaSchema,
    // Two lines is the minimum that can balance.
    lines: z.array(PackLineSchema).min(2).max(50),
  })
  .strict()

export type Pack = z.infer<typeof PackSchema>
export type PackLine = z.infer<typeof PackLineSchema>
export type PackMeta = z.infer<typeof PackMetaSchema>
