import { describe, it, expect } from 'vitest'
import {
  INITIAL_AGENT_STATUS,
  collapsedStatusLabel,
  reduceAgentStatus,
  type AgentStatus,
  type AgentStatusEvent,
} from '../agent-status'

/**
 * What this protects: a user who minimizes the panel mid-answer used to lose
 * every signal about it. The reducer is what decides whether the trigger says
 * "arbetar", "är klar", or nothing at all, so these are the real transitions,
 * not a description of them.
 */
function run(events: AgentStatusEvent[], from: AgentStatus = INITIAL_AGENT_STATUS): AgentStatus {
  return events.reduce(reduceAgentStatus, from)
}

describe('reduceAgentStatus', () => {
  it('reports a finished turn only when it finished out of sight', () => {
    const onScreen = run([{ type: 'turn_start' }, { type: 'turn_end' }])
    expect(onScreen.activity).toBe('idle')

    const hidden = run([
      { type: 'turn_start' },
      { type: 'visibility', visible: false },
      { type: 'turn_end' },
    ])
    expect(hidden.activity).toBe('done')
  })

  it('clears the finished-turn signal once the panel is back on screen', () => {
    const seen = run([
      { type: 'turn_start' },
      { type: 'visibility', visible: false },
      { type: 'turn_end' },
      { type: 'visibility', visible: true },
    ])
    expect(seen.activity).toBe('idle')
    expect(seen.step).toBeNull()
  })

  it('does not cancel work that is still running when the panel reopens', () => {
    // Reopening mid-answer must not read as "nothing is happening": the pill
    // would go quiet while the turn was still streaming.
    const stillWorking = run([
      { type: 'turn_start' },
      { type: 'step', label: 'Bokar avskrivningar…' },
      { type: 'visibility', visible: false },
      { type: 'visibility', visible: true },
    ])
    expect(stillWorking.activity).toBe('working')
    expect(stillWorking.step).toBe('Bokar avskrivningar…')
  })

  it('keeps the latest step and drops it when the turn ends', () => {
    const mid = run([
      { type: 'turn_start' },
      { type: 'step', label: 'Hämtar underlag…' },
      { type: 'step', label: 'Bokar avskrivningar…' },
    ])
    expect(mid.step).toBe('Bokar avskrivningar…')
    expect(reduceAgentStatus(mid, { type: 'turn_end' }).step).toBeNull()
  })

  it('treats a step for work it never saw start as working', () => {
    // A stream resumed after a remount can deliver a tool event with no
    // turn_start behind it; dropping it would leave the pill idle mid-turn.
    expect(reduceAgentStatus(INITIAL_AGENT_STATUS, { type: 'step', label: 'Bokar…' }).activity).toBe(
      'working',
    )
  })

  it('remembers visibility across a reset so the next turn reports correctly', () => {
    const afterReset = run([
      { type: 'visibility', visible: false },
      { type: 'turn_start' },
      { type: 'reset' },
      { type: 'turn_start' },
      { type: 'turn_end' },
    ])
    expect(afterReset.activity).toBe('done')
  })

  it('carries the detached state built for durable runs', () => {
    // Nothing dispatches this in v1. It exists so a background run publishes to
    // this channel instead of the pill needing a second one.
    const detached = reduceAgentStatus(INITIAL_AGENT_STATUS, {
      type: 'detached',
      label: 'Kör momsavstämning',
    })
    expect(detached.activity).toBe('detached')
    expect(collapsedStatusLabel(detached, 'Anna')).toBe('Kör momsavstämning')
  })
})

describe('collapsedStatusLabel', () => {
  it('says nothing when there is nothing to say', () => {
    expect(collapsedStatusLabel(INITIAL_AGENT_STATUS, 'Anna')).toBeNull()
  })

  it('drops the narration ellipsis so the pill does not read as two spinners', () => {
    const working = run([{ type: 'turn_start' }, { type: 'step', label: 'Bokar avskrivningar…' }])
    expect(collapsedStatusLabel(working, 'Anna')).toBe('Bokar avskrivningar')
  })

  it('falls back to the agent name while working without a named step', () => {
    expect(collapsedStatusLabel(run([{ type: 'turn_start' }]), 'Anna')).toBe('Anna arbetar')
  })

  it('announces a finished turn by name', () => {
    const done = run([
      { type: 'visibility', visible: false },
      { type: 'turn_start' },
      { type: 'turn_end' },
    ])
    expect(collapsedStatusLabel(done, 'Anna')).toBe('Anna är klar')
  })
})
