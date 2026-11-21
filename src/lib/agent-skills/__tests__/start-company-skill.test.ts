/**
 * The start-company skill has one text. The connector serves it
 * (gnubok_load_skill), and skills/accounted-start-company/SKILL.md is the
 * same text for a founder's own AI without the connector: the public copy,
 * and the file /api/formation/:id/skill zips. This keeps the file in step;
 * after changing the skill, run this test with -u.
 */
import { describe, expect, it } from 'vitest'
import { startCompanySkill } from '../workflows/start-company'
import { workflowSkills } from '../workflows'

const FRONTMATTER = `---
name: accounted-start-company
description: Help a founder start a Swedish aktiebolag (limited company) and get it running. Use when the person wants to start an AB, asks what to enter on verksamt.se, who must sit on the board, how to word the business description, which bank to use, what to file with Skatteverket, or what to do after the organisation number arrives. Works on its own; with the Accounted connector it also makes the documents and sets the company up in Accounted.
---

`

describe('start-company skill', () => {
  it('is served by the connector', () => {
    expect(workflowSkills.map((s) => s.slug)).toContain('start-company')
  })

  it('never asks for a personnummer in the chat', () => {
    expect(startCompanySkill.body).toMatch(/Never ask for, repeat or store a personnummer in the chat/)
  })

  it('names only the actions gnubok_formation has', () => {
    const actions = [...startCompanySkill.body.matchAll(/action: "(\w+)"/g)].map((m) => m[1])
    expect(new Set(actions)).toEqual(new Set(['save', 'submitted', 'setup', 'status']))
  })

  it('is the same text as skills/accounted-start-company/SKILL.md', async () => {
    await expect(FRONTMATTER + startCompanySkill.body).toMatchFileSnapshot('../../../../skills/accounted-start-company/SKILL.md')
  })
})
