import { describe, expect, it } from 'vitest'
import { communitySlug, githubNewFileUrl, parseCommunitySkillMd, privacyFindings, publicBody, toCommunitySkillMd } from '../community-repo'

const submission = {
  slug: 'manadsavstamning-bank', title: 'Månadsavstämning av banken', description: 'Stämmer av bankkontot varje månad.',
  kind: 'rules' as const, author: 'jakob', submissionId: '00000000-0000-4000-8000-000000000001',
  body: '# Månadsavstämning av banken\n\nStäm av 1930.\n\n## Så beskrev användaren det\n\nVi har Swedbank och kunden Acme.\n',
}

describe('community-repo', () => {
  it('makes a folder name from a Swedish title', () => {
    expect(communitySlug('Månadsavstämning av banken')).toBe('manadsavstamning-av-banken')
    expect(communitySlug('  !!  ')).toBe('instruktion')
  })

  it('keeps the user\'s own words out of what goes public', () => {
    expect(publicBody(submission.body)).toBe('# Månadsavstämning av banken\n\nStäm av 1930.\n')
  })

  it('writes a SKILL.md that reads back as the same item, knowledge called knowledge in the repo', () => {
    const md = toCommunitySkillMd(submission)
    expect(md).toContain('kind: knowledge')
    expect(md).not.toContain('Acme')
    const parsed = parseCommunitySkillMd('manadsavstamning-bank', md)
    expect(parsed).toMatchObject({ slug: 'manadsavstamning-bank', title: 'Månadsavstämning av banken', kind: 'rules', author: 'jakob', submissionId: submission.submissionId, industries: [] })
  })

  it('names what to fix in a broken file', () => {
    expect(parseCommunitySkillMd('x', '# no frontmatter')).toEqual({ error: 'missing frontmatter' })
    expect(parseCommunitySkillMd('other', toCommunitySkillMd(submission))).toEqual({ error: 'name must match the folder name' })
    expect(parseCommunitySkillMd('Bad Name', 'x')).toMatchObject({ error: expect.stringContaining('folder name') })
    const wrongKind = toCommunitySkillMd(submission).replace('kind: knowledge', 'kind: poem')
    expect(parseCommunitySkillMd('manadsavstamning-bank', wrongKind)).toMatchObject({ error: expect.stringContaining('kind') })
  })

  it('flags what must never be published', () => {
    const found = privacyFindings('Ring 070-123 45 67 eller mejla anna@firma.se. Personnr 19850101-1234, orgnr 559538-6219.')
    expect(found.map((f) => f.kind)).toEqual(expect.arrayContaining(['phone', 'email', 'personnummer', 'orgnummer']))
    expect(privacyFindings('Bokför på konto 5420 med 25 % moms.')).toEqual([])
  })

  it('opens GitHub\'s editor with the file, or hands over when it is too long', () => {
    expect(githubNewFileUrl('x', 'short')).toBe('https://github.com/erp-mafia/accounted-skills/new/main?filename=community%2Fx%2FSKILL.md&value=short')
    expect(githubNewFileUrl('x', 'å'.repeat(5000))).toBeNull()
  })
})
