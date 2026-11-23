import { describe, expect, it } from 'vitest'
import { yearEndCloseSkill } from '../workflows/year-end-close'

// gnubok_year_end_readiness lists only the blockers to the close. The year's
// work (sign-offs at balansdagen, periodiseringar, dispositioner, tax) is the
// checklist in gnubok_get_bokslutsbilagor, which the skill used to leave out
// while calling readiness "the scope of work".
describe('year-end-close skill: the scope of work is the checklist', () => {
  const body = yearEndCloseSkill.body
  const step1 = body.slice(body.indexOf('## Step 1: Readiness'), body.indexOf('## Step 2'))

  it('does not call readiness the scope of work', () => {
    expect(body).not.toMatch(/readiness[^\n]*scope of work/i)
    expect(step1).toMatch(/`ready: true` means the close can run, not that the bokslut is done/)
  })

  it('points to the bokslutsbilagor checklist in Step 1 and in the tool list', () => {
    expect(step1).toContain('gnubok_get_bokslutsbilagor')
    expect(step1).toContain('checklist.items')
    expect(body.slice(body.indexOf('## Tools'))).toContain('gnubok_get_bokslutsbilagor')
  })
})
