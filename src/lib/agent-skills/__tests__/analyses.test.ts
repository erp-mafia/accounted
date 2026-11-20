import { describe, expect, it } from 'vitest'
import { analysisSkills } from '../analyses'
import { workflowSkills } from '../workflows'

describe("Accounted's own analyses", () => {
  it('ships three analyses, loadable like any built-in skill', () => {
    expect(analysisSkills.map((s) => s.slug)).toEqual(['analys-manadsoversikt', 'analys-kassaprognos', 'analys-kostnadskoll'])
    for (const s of analysisSkills) {
      expect(workflowSkills).toContain(s)
      expect(s).toMatchObject({ itemKind: 'analysis', source: 'accounted', tier: 'workflow' })
    }
  })

  it('builds the cash forecast from cash-forecast.get instead of recomputing it from invoices and the journal', () => {
    const kassa = analysisSkills.find((s) => s.slug === 'analys-kassaprognos')!
    expect(kassa.body).toContain('`gnubok_get_cash_forecast`')
    expect(kassa.body).toContain('räkna inte om den')
    for (const recomputed of ['gnubok_query_journal', 'gnubok_list_invoices', 'gnubok_list_supplier_invoices', 'gnubok_list_uncategorized_transactions']) {
      expect(kassa.body, recomputed).not.toContain(recomputed)
    }
  })

  it('asks for a dashboard drawn without external libraries, from Accounted figures only, and changes nothing', () => {
    for (const s of analysisSkills) {
      expect(s.body).toContain('artifact')
      expect(s.body).toContain('enkel SVG')
      expect(s.body).toContain('Använd bara belopp du hämtat från Accounted')
      expect(s.body).toContain('Ändra ingenting i Accounted')
    }
  })
})
