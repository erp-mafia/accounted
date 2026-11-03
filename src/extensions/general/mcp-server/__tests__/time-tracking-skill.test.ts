/**
 * The time-tracking skill and its loadout name only tools that exist, and the
 * loadout carries every time-entry tool, so an agent that loads the skill
 * never meets a dead reference.
 */
import { describe, expect, it } from 'vitest'
import { timeTrackingSkill } from '@/lib/agent-skills/workflows/time-tracking'
import { RECOMMENDED_WORKFLOW_LOADOUTS } from '../recommended-tools'
import { tools } from '../server'
import { workflowSkills } from '../skills'

const toolNames = new Set(tools.map((t) => t.name))
const skillSlugs = new Set(workflowSkills.map((s) => s.slug))

describe('time-tracking skill', () => {
  it('names only registered tools', () => {
    const named = [...new Set(timeTrackingSkill.body.match(/gnubok_[a-z_]+/g) ?? [])]
    expect(named.length).toBeGreaterThan(5)
    expect(named.filter((name) => !toolNames.has(name))).toEqual([])
  })

  it('points only at skills that exist', () => {
    for (const slug of ['customer-onboarding', 'kreditfaktura-process', 'invoicing-rules']) {
      expect(timeTrackingSkill.body).toContain(slug)
      expect(skillSlugs.has(slug), slug).toBe(true)
    }
  })

  it('has a log_time loadout with every time-entry tool, ending in approval', () => {
    const loadout = RECOMMENDED_WORKFLOW_LOADOUTS.find((l) => l.workflow === 'log_time')
    expect(loadout?.skill).toBe('time-tracking')
    const timeTools = [...toolNames].filter((n) => /time_(entry|entries|codes|summary)|log_time/.test(n))
    expect(timeTools).toHaveLength(6)
    expect(loadout?.tools).toEqual(expect.arrayContaining(timeTools))
    expect(loadout?.tools.at(-1)).toBe('gnubok_approve_pending_operation')
  })
})
