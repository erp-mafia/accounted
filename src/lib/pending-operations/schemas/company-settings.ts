import type { z } from 'zod'
import {
  validateBankgiroNumber,
  validatePlusgiroNumber,
} from '@/lib/bankgiro/luhn'
import { INVOICE_EMAIL_PLACEHOLDER_KEYS } from '@/lib/email/invoice-templates'
import { MAX_INVOICE_EMAIL_COPY_RECIPIENTS } from '@/lib/invoices/email-recipients'

// Placeholders in the company-editable invoice email texts are a FIXED set.
// applyPlaceholders() (lib/email/user-text.ts) leaves an unrecognised key
// untouched by design, so an invented "{faktura_nr}" would reach the customer
// with the braces intact. Agents invent placeholder names freely, so reject
// them at the machine doors rather than in the outgoing mail.
const ALLOWED_PLACEHOLDERS: ReadonlySet<string> = new Set(INVOICE_EMAIL_PLACEHOLDER_KEYS)
const ALLOWED_PLACEHOLDER_LIST = INVOICE_EMAIL_PLACEHOLDER_KEYS.map((key) => `{${key}}`).join(' ')

// Same token pattern applyPlaceholders() substitutes on, and the same
// trim + lower-case key normalisation, so validation and rendering agree.
function findUnknownPlaceholders(text: string): string[] {
  const tokens = text.match(/\{[^{}]*\}/g) ?? []
  return tokens.filter(
    (token) => !ALLOWED_PLACEHOLDERS.has(token.slice(1, -1).trim().toLowerCase()),
  )
}

const INVOICE_EMAIL_TEXT_FIELDS = ['subject', 'greeting', 'body', 'signoff'] as const
const INVOICE_EMAIL_TEXT_LANGS = ['sv', 'en'] as const

type InvoiceEmailTexts = Partial<Record<(typeof INVOICE_EMAIL_TEXT_LANGS)[number], Partial<Record<string, unknown>>>>

interface InvoiceSettingsFields {
  bankgiro?: string | null
  plusgiro?: string | null
  invoice_email_texts?: InvoiceEmailTexts | null
  invoice_email_cc_addresses?: readonly string[] | null
  invoice_email_bcc_addresses?: readonly string[] | null
}

/**
 * The machine-door rules on top of the dashboard's field shapes, for the
 * settings.update operation (gnubok_update_company_settings and PATCH
 * /api/v1/companies/:companyId/settings): Luhn-checked Bankgiro/Plusgiro,
 * the fixed invoice-email placeholder set, and the copy-recipient cap the
 * dashboard schema applies as a whole-object refinement.
 */
export function refineInvoiceSettings(changes: InvoiceSettingsFields, ctx: z.RefinementCtx): void {
  if (changes.bankgiro && !validateBankgiroNumber(changes.bankgiro)) {
    ctx.addIssue({ code: 'custom', path: ['bankgiro'], message: 'Invalid Bankgiro number' })
  }

  if (changes.plusgiro && !validatePlusgiroNumber(changes.plusgiro)) {
    ctx.addIssue({ code: 'custom', path: ['plusgiro'], message: 'Invalid Plusgiro number' })
  }

  const copies =
    (changes.invoice_email_cc_addresses?.length ?? 0) + (changes.invoice_email_bcc_addresses?.length ?? 0)
  if (copies > MAX_INVOICE_EMAIL_COPY_RECIPIENTS) {
    ctx.addIssue({
      code: 'custom',
      path: ['invoice_email_cc_addresses'],
      message: `Högst ${MAX_INVOICE_EMAIL_COPY_RECIPIENTS} fasta kopiemottagare är tillåtna totalt`,
    })
  }

  const texts = changes.invoice_email_texts
  if (texts) {
    for (const lang of INVOICE_EMAIL_TEXT_LANGS) {
      const langTexts = texts[lang]
      if (!langTexts) continue
      for (const field of INVOICE_EMAIL_TEXT_FIELDS) {
        const value = langTexts[field]
        if (typeof value !== 'string') continue
        const unknown = findUnknownPlaceholders(value)
        if (unknown.length > 0) {
          ctx.addIssue({
            code: 'custom',
            path: ['invoice_email_texts', lang, field],
            message: `Unknown placeholder ${unknown.join(', ')}. Allowed placeholders: ${ALLOWED_PLACEHOLDER_LIST}`,
          })
        }
      }
    }
  }
}

/**
 * update_company_settings rows staged before the tool became the
 * settings.update operation carry `{ changes: { ..., default_our_reference } }`.
 * Approving one must still work: lift the changes to the operation's flat
 * input and give the reference its public name. Anything else is passed
 * through untouched, so the commit-boundary validation still refuses it.
 */
export function upgradeLegacyCompanySettingsParams(params: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(params)
  const changes = params.changes
  if (
    keys.length !== 1 ||
    keys[0] !== 'changes' ||
    typeof changes !== 'object' ||
    changes === null ||
    Array.isArray(changes)
  ) {
    return params
  }
  const { default_our_reference, ...rest } = changes as Record<string, unknown>
  return default_our_reference === undefined ? rest : { ...rest, contact_person: default_our_reference }
}
