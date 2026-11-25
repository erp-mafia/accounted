/**
 * The invoice colours and the header and footer line are set under
 * Inställningar > Fakturor. The defaults, the colour format and the text
 * lengths there must agree with the database columns and the settings save,
 * or the page offers a value the save refuses.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_INVOICE_ACCENT_COLOR,
  DEFAULT_INVOICE_PRIMARY_COLOR,
  INVOICE_FOOTER_TEXT_MAX_LENGTH,
  INVOICE_HEADER_TEXT_MAX_LENGTH,
  normalizeInvoiceColor,
} from '@/lib/invoices/branding-constants'
import { resolveBranding } from '@/lib/invoices/pdf/styles'
import { UpdateSettingsSchema } from '@/lib/api/schemas'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260526120200_invoice_branding.sql'),
  'utf8',
)

function columnDefault(column: string): string | undefined {
  return new RegExp(`${column} TEXT NOT NULL DEFAULT '([^']+)'`).exec(migration)?.[1]
}

describe('invoice branding defaults', () => {
  it('are the database column defaults', () => {
    expect(columnDefault('invoice_primary_color')).toBe(DEFAULT_INVOICE_PRIMARY_COLOR)
    expect(columnDefault('invoice_accent_color')).toBe(DEFAULT_INVOICE_ACCENT_COLOR)
  })

  it('are what the PDF prints when nothing is set', () => {
    expect(resolveBranding({})).toMatchObject({
      primaryColor: DEFAULT_INVOICE_PRIMARY_COLOR,
      accentColor: DEFAULT_INVOICE_ACCENT_COLOR,
    })
  })
})

describe('normalizeInvoiceColor', () => {
  it('takes a hex code with or without the #, in lower case', () => {
    expect(normalizeInvoiceColor('#C2410C')).toBe('#c2410c')
    expect(normalizeInvoiceColor(' c2410c ')).toBe('#c2410c')
  })

  it('refuses what the column constraint refuses', () => {
    expect(normalizeInvoiceColor('#abc')).toBeNull()
    expect(normalizeInvoiceColor('#c2410c0')).toBeNull()
    expect(normalizeInvoiceColor('red')).toBeNull()
    expect(normalizeInvoiceColor('')).toBeNull()
  })

  it('gives only values the settings save accepts', () => {
    for (const input of ['#C2410C', 'c2410c', '#000000']) {
      const color = normalizeInvoiceColor(input)
      expect(UpdateSettingsSchema.safeParse({ invoice_primary_color: color }).success).toBe(true)
      expect(UpdateSettingsSchema.safeParse({ invoice_accent_color: color }).success).toBe(true)
    }
  })
})

describe('the settings save of the header and footer line', () => {
  it('accepts the length the settings fields allow, and no more', () => {
    const header = 'a'.repeat(INVOICE_HEADER_TEXT_MAX_LENGTH)
    const footer = 'a'.repeat(INVOICE_FOOTER_TEXT_MAX_LENGTH)
    expect(UpdateSettingsSchema.safeParse({ invoice_header_text: header }).success).toBe(true)
    expect(UpdateSettingsSchema.safeParse({ invoice_footer_text: footer }).success).toBe(true)
    expect(UpdateSettingsSchema.safeParse({ invoice_header_text: `${header}a` }).success).toBe(false)
    expect(UpdateSettingsSchema.safeParse({ invoice_footer_text: `${footer}a` }).success).toBe(false)
  })

  it('clears with null', () => {
    expect(
      UpdateSettingsSchema.safeParse({ invoice_header_text: null, invoice_footer_text: null }).success,
    ).toBe(true)
  })
})
