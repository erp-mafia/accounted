import { z } from 'zod'
import { UpdateSettingsSchema } from '@/lib/api/schemas'
import {
  validateBankgiroNumber,
  validatePlusgiroNumber,
} from '@/lib/bankgiro/luhn'
import { INVOICE_EMAIL_PLACEHOLDER_KEYS } from '@/lib/email/invoice-templates'

// Placeholders in the company-editable invoice email texts are a FIXED set.
// applyPlaceholders() (lib/email/user-text.ts) leaves an unrecognised key
// untouched by design, so an invented "{faktura_nr}" would reach the customer
// with the braces intact. Agents invent placeholder names freely, so reject
// them at the staging boundary rather than in the outgoing mail.
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

const CompanySettingsChangesSchema = z
  .object({
    bank_name: UpdateSettingsSchema.shape.bank_name,
    clearing_number: UpdateSettingsSchema.shape.clearing_number,
    account_number: UpdateSettingsSchema.shape.account_number,
    bankgiro: UpdateSettingsSchema.shape.bankgiro,
    plusgiro: UpdateSettingsSchema.shape.plusgiro,
    swish: UpdateSettingsSchema.shape.swish,
    iban: UpdateSettingsSchema.shape.iban,
    bic: UpdateSettingsSchema.shape.bic,
    default_our_reference: UpdateSettingsSchema.shape.default_our_reference,
    email: UpdateSettingsSchema.shape.email,
    phone: UpdateSettingsSchema.shape.phone,
    website: UpdateSettingsSchema.shape.website,
    invoice_email_texts: UpdateSettingsSchema.shape.invoice_email_texts,
  })
  .strict()
  .superRefine((changes, ctx) => {
    if (Object.keys(changes).length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'At least one company setting must be supplied',
      })
    }

    if (changes.bankgiro && !validateBankgiroNumber(changes.bankgiro)) {
      ctx.addIssue({
        code: 'custom',
        path: ['bankgiro'],
        message: 'Invalid Bankgiro number',
      })
    }

    if (changes.plusgiro && !validatePlusgiroNumber(changes.plusgiro)) {
      ctx.addIssue({
        code: 'custom',
        path: ['plusgiro'],
        message: 'Invalid Plusgiro number',
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
  })

export const UpdateCompanySettingsParamsSchema = z
  .object({
    changes: CompanySettingsChangesSchema,
  })
  .strict()

