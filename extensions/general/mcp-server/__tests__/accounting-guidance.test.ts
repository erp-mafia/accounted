import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { monthEndCloseSkill } from '../skills/month-end-close'
import { quarterlyVatReviewSkill } from '../skills/quarterly-vat-review'
import { yearEndCloseSkill } from '../skills/year-end-close'

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')

// These protect the advice exposed to agents, not legal correctness of the ledger.
// Keep the official sources in each owning body; changes to law require review.
describe('Accounting guidance controls', () => {
  it('reconciles all output VAT boxes and makes input deduction conditional', () => {
    const body = quarterlyVatReviewSkill.body
    expect(body).toContain('(10 + 11 + 12 + 30 + 31 + 32 + 60 + 61 + 62) - 48')
    expect(body).toContain('the two amounts need not be equal')
    expect(body).toContain('an absent box is not zero')
    expect(body).toContain('12 August')
    expect(body).not.toContain('17 August')
    expect(body).toContain('restaurant/catering services remain 12%')
  })

  it('keeps filed-return corrections in their original reporting period on both agent surfaces', () => {
    for (const body of [quarterlyVatReviewSkill.body, source('claude-plugin/skills/vat/SKILL.md')]) {
      expect(body).toMatch(/original reporting period/i)
      expect(body).not.toMatch(/correction goes in the current one/i)
      expect(body).toContain('rattaenmomsdeklaration')
    }
  })

  it('does not mistake bank-queue completion for invoice-method completeness', () => {
    expect(monthEndCloseSkill.body).toContain('unpaid receivables/payables')
    expect(monthEndCloseSkill.body).toContain('owner-paid purchases')
    expect(monthEndCloseSkill.body).toContain("A real movement in an AB's bank account must remain accounted for")
    expect(monthEndCloseSkill.body).toContain('does not automatically authorize locking the entire fiscal year')
    expect(monthEndCloseSkill.body).not.toContain('staging is non-negotiable for legal compliance')
  })

  it('requires current tax before the irreversible close without assuming K2 eligibility', () => {
    expect(yearEndCloseSkill.body).toContain('Before the irreversible year-end run')
    expect(yearEndCloseSkill.body).toContain('must already include current tax')
    expect(yearEndCloseSkill.body).not.toContain('After year-end JE but before filing INK2')
    expect(yearEndCloseSkill.body).toContain('Size alone does not establish K2 eligibility')
    expect(yearEndCloseSkill.body).not.toContain('irreversible per BFL')
  })

  it('maps EU and non-EU SaaS service bases in the correct direction', () => {
    const body = source('.claude/skills/industry/software-saas-ai/SKILL.md')
    expect(body).toMatch(/\| \*\*4535\*\* \| Inköp av tjänster från annat EU-land/)
    expect(body).toMatch(/\| \*\*4531\*\* \| Inköp av tjänster från land utanför EU/)
    expect(body).toMatch(/\| AWS EMEA SARL \| Luxemburg \(EU\) \| 4535 \|/)
    expect(body).toMatch(/\| Anthropic PBC \| USA \(utanför EU\) \| 4531 \|/)
    expect(body).toContain('Inköp tjänster annat EU-land (4535)')
    expect(body).toContain('Inköp tjänster utanför EU (4531)')
    expect(body).toContain('4531 Inköp tjänster från land utanför EU 25%')
    expect(body).toContain('Exemplen med lika momsbelopp förutsätter full avdragsrätt.')
  })

  it('routes owner-managed-company advice to current-year rules rather than POC thresholds', () => {
    const body = source('.claude/skills/modifier/single-shareholder-ab-fmb/SKILL.md')
    expect(body).not.toContain('POC test content')
    expect(body).not.toContain('6 IBB + 5%')
    expect(body).toContain('IL 57 kap.')
    expect(body).toContain('Skatteverket recommends filing K10')
    expect(body).toContain('does not by itself establish employment')
    expect(body).toContain('not thereby salary subject to employer contributions')
  })

  it.each([
    '.claude/skills/swedish-accounting-compliance/SKILL.md',
    '.claude/skills/swedish-accounting-compliance/references/bfl-bfnar.md',
  ])('distinguishes ledger corrections from supporting-document edits in %s', (path) => {
    const body = source(path)
    expect(body).toContain('separate correcting entry')
    expect(body).toContain('2.17-2.18')
    expect(body).toContain('BFL 5 kap. 9 § separately concerns correction of a verifikation')
    expect(body).not.toMatch(/BFL permits two tracks|Two permitted tracks/)
  })

  it.each([
    '.claude/skills/swedish-financial-reporting/SKILL.md',
    '.claude/skills/swedish-financial-reporting/references/bolagsverket-filing.md',
    '.claude/skills/swedish-year-end-closing/references/reporting-and-filing.md',
    '.claude/skills/swedish-accounting-compliance/references/bfl-bfnar.md',
  ])('preserves adoption-based annual-report deadlines in %s', (path) => {
    expect(source(path)).toMatch(/within one month after (?:the meeting adopts|adoption)/i)
    expect(source(path)).not.toMatch(/must reach Bolagsverket \*\*within 7 months\*\*|Årsredovisning to Bolagsverket \| July 31/)
  })
})
