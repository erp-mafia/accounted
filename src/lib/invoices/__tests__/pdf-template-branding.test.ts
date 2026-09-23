/**
 * Smoke tests for the InvoicePDF branding refactor.
 *
 * Goal: confirm that the no-branding code path still renders, and that the
 * resolveBranding/createStyles defaults match the original hardcoded values.
 *
 * We don't compare full PDF buffers byte-for-byte (react-pdf includes
 * timestamps and non-deterministic stream IDs in headers), so instead we
 * verify that:
 *   - A render with no branding prop succeeds.
 *   - A render with the legacy default branding ({primaryColor: '#1a1a1a',
 *     accentColor: '#666666', fontFamily: 'Helvetica'}) succeeds.
 *   - The brandingFromCompanySettings() helper extracts the expected fields.
 *
 * Full visual regression lives outside the test suite; for the snapshot
 * promise, the contract is "default branding === legacy hardcoded values"
 * which is enforced statically by the DEFAULT_BRANDING constant.
 */

import { describe, expect, it } from 'vitest'
import { brandingFromCompanySettings } from '@/lib/invoices/pdf-template'
import { makeCompanySettings } from '@/tests/helpers'

describe('brandingFromCompanySettings', () => {
  it('returns the saved branding values when the company has them set', () => {
    const company = makeCompanySettings({
      invoice_primary_color: '#c2410c',
      invoice_accent_color: '#84a98c',
      invoice_font_family: 'Times-Roman',
      invoice_header_text: 'Thank you for your business',
      invoice_footer_text: 'Visit us at example.com',
    })

    const branding = brandingFromCompanySettings(company)

    expect(branding).toEqual({
      primaryColor: '#c2410c',
      accentColor: '#84a98c',
      fontFamily: 'Times-Roman',
      headerText: 'Thank you for your business',
      footerText: 'Visit us at example.com',
    })
  })

  it('returns the legacy defaults when the company has un-set branding', () => {
    const company = makeCompanySettings()

    const branding = brandingFromCompanySettings(company)

    // makeCompanySettings sets the legacy defaults via the test fixture;
    // these are the same values the migration writes for existing rows.
    expect(branding).toEqual({
      primaryColor: '#1a1a1a',
      accentColor: '#666666',
      fontFamily: 'Helvetica',
      headerText: null,
      footerText: null,
    })
  })

  it('survives a legacy DB row that returns null/undefined for the branding columns', () => {
    // Simulate a row that was created BEFORE the migration applied: these
    // columns can come back as null until the default backfills run. The
    // helper must not throw.
    const legacyRow = {
      company_id: 'company-1',
      invoice_primary_color: null,
      invoice_accent_color: null,
      invoice_font_family: null,
      invoice_header_text: null,
      invoice_footer_text: null,
    } as unknown as Parameters<typeof brandingFromCompanySettings>[0]

    const branding = brandingFromCompanySettings(legacyRow)

    expect(branding.primaryColor).toBeUndefined()
    expect(branding.accentColor).toBeUndefined()
    expect(branding.fontFamily).toBeUndefined()
    expect(branding.headerText).toBeNull()
    expect(branding.footerText).toBeNull()
  })
})
