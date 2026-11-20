import { describe, expect, it } from 'vitest'
import { createTranslator } from 'next-intl'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'
import { CompanyMigrationResetSchema } from '@/lib/api/schemas'

/**
 * The "Gör om migrering" filing attestation (decision
 * 2026-10-18-migration-reset-attestation-reading, PH 185): it covers filings
 * made on the basis of the bookkeeping in Accounted, through any channel. A
 * company that still keeps its books in its previous system has filed from
 * that system, and the old wording ("från företaget, varken via ... eller på
 * annat sätt") asked it to attest something untrue before it could redo a
 * migration.
 */

const tSv = createTranslator({ locale: 'sv', messages: sv, namespace: 'settings_company' })
const tEn = createTranslator({ locale: 'en', messages: en, namespace: 'settings_company' })

const VALID = {
  confirm_name: 'Exempel AB',
  reason: 'Migreringen importerade samma år två gånger.',
  confirm_no_filed_declarations: true as const,
  confirm_retained_archive: true as const,
}

describe('the migration reset filing attestation', () => {
  it('names the bookkeeping in the app as the basis, in Swedish', () => {
    const text = tSv('reset_confirm_no_filings', { appName: 'Accounted' })
    expect(text).toBe(
      'Jag bekräftar att inga deklarationer, kontrolluppgifter, ROT/RUT-begäranden eller årsredovisningar '
      + 'har lämnats in med bokföringen i Accounted som underlag, varken via Accounted eller på annat sätt.',
    )
    expect(text).not.toContain('från företaget')
  })

  it('names the same basis in English, still covering every channel', () => {
    const text = tEn('reset_confirm_no_filings', { appName: 'Accounted' })
    expect(text).toContain('on the basis of the bookkeeping in Accounted')
    expect(text).toContain('through Accounted or otherwise')
    expect(text).not.toContain('for this company')
  })

  it('is still required: a request without it is refused with the same reading', () => {
    expect(CompanyMigrationResetSchema.safeParse(VALID).success).toBe(true)
    const refused = CompanyMigrationResetSchema.safeParse({ ...VALID, confirm_no_filed_declarations: false })
    expect(refused.success).toBe(false)
    if (!refused.success) {
      expect(refused.error.issues[0].path).toEqual(['confirm_no_filed_declarations'])
      expect(refused.error.issues[0].message).toContain('med den här bokföringen som underlag')
    }
  })
})
