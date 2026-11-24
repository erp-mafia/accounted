import { describe, expect, it } from 'vitest'
import {
  generatePeppolPlanRequiredEmailHtml,
  generatePeppolPlanRequiredEmailSubject,
  generatePeppolPlanRequiredEmailText,
} from '@/lib/email/peppol-plan-required-templates'

const data = { companyName: 'Kund AB', billingUrl: 'https://app.example.test/settings/billing', appName: 'Accounted' }

describe('peppol plan-required mail', () => {
  it('says what was asked, why it is not on, and where to choose a plan', () => {
    expect(generatePeppolPlanRequiredEmailSubject()).toBe('Peppol kräver ett betalt abonnemang')
    const text = generatePeppolPlanRequiredEmailText(data)
    expect(text).toContain('Vi har tagit emot begäran om Peppol för Kund AB.')
    expect(text).toContain('Kund AB har inget betalt abonnemang just nu')
    expect(text).toContain('slås Peppol på automatiskt')
    expect(text).toContain('Välj abonnemang: https://app.example.test/settings/billing')
    expect(text).toContain('Du får det här mejlet för att du begärde Peppol i Accounted.')
    const html = generatePeppolPlanRequiredEmailHtml(data)
    expect(html).toContain('href="https://app.example.test/settings/billing"')
  })

  it('escapes the company name in the html', () => {
    const html = generatePeppolPlanRequiredEmailHtml({ ...data, companyName: '<b>A & B</b>' })
    expect(html).not.toContain('<b>A')
    expect(html).toContain('&lt;b&gt;A &amp; B&lt;/b&gt;')
  })
})
