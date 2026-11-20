/**
 * Shape of migration 20261004004343_invoice_qr_mode.sql: the two QR mode
 * columns carry exactly the modes the code knows (INVOICE_QR_MODES), the
 * company default is auto, the per-invoice override is nullable, and the
 * migration writes no rows (an UPDATE on company_settings would trip
 * block_migration_reset_source_mutation) and drops nothing.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { INVOICE_QR_MODES } from '@/types'

const SQL = readFileSync(
  join(process.cwd(), 'supabase/migrations/20261004004343_invoice_qr_mode.sql'),
  'utf8',
)
/** The statements, without comment lines. */
const CODE = SQL.split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n')

function checkValues(constraint: string): string[] {
  const match = new RegExp(`CONSTRAINT ${constraint}\\s+CHECK \\(\\w+ IN \\(([^)]*)\\)\\)`).exec(CODE)
  expect(match, constraint).not.toBeNull()
  return match![1].split(',').map((value) => value.trim().replace(/^'|'$/g, ''))
}

describe('migration 20261004004343_invoice_qr_mode', () => {
  it('adds the company default as NOT NULL DEFAULT auto', () => {
    expect(CODE).toMatch(
      /ALTER TABLE public\.company_settings\s+ADD COLUMN IF NOT EXISTS invoice_qr_mode text NOT NULL DEFAULT 'auto'/,
    )
  })

  it('adds the per-invoice override as a nullable column', () => {
    expect(CODE).toMatch(/ALTER TABLE public\.invoices\s+ADD COLUMN IF NOT EXISTS qr_mode text NULL/)
  })

  it('constrains both columns to exactly the modes the code knows', () => {
    expect(checkValues('company_settings_invoice_qr_mode_check')).toEqual([...INVOICE_QR_MODES])
    expect(checkValues('invoices_qr_mode_check')).toEqual([...INVOICE_QR_MODES])
  })

  it('documents both columns and marks the old bank-app switch as superseded', () => {
    expect(CODE).toContain('COMMENT ON COLUMN public.company_settings.invoice_qr_mode IS')
    expect(CODE).toContain('COMMENT ON COLUMN public.invoices.qr_mode IS')
    expect(CODE).toMatch(/COMMENT ON COLUMN public\.company_settings\.invoice_show_payment_qr IS\s+'Superseded/)
  })

  it('writes no rows and drops nothing', () => {
    expect(CODE).not.toMatch(/\bUPDATE\b/i)
    expect(CODE).not.toMatch(/\bDELETE\b/i)
    expect(CODE).not.toMatch(/\bDROP\b/i)
  })

  it('reloads the PostgREST schema cache', () => {
    expect(CODE.trim().endsWith("NOTIFY pgrst, 'reload schema';")).toBe(true)
  })
})
