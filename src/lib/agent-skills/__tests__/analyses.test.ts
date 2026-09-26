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

  it('asks for a dashboard drawn without external libraries, from Accounted figures only, and changes nothing', () => {
    for (const s of analysisSkills) {
      expect(s.body).toContain('artifact')
      expect(s.body).toContain('enkel SVG')
      expect(s.body).toContain('Använd bara belopp du hämtat från Accounted')
      expect(s.body).toContain('Ändra ingenting i Accounted')
    }
  })
})
