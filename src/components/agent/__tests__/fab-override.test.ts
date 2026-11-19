import { describe, expect, it } from 'vitest'
import { resolveFabOverride, type FabOverride } from '../fab-override'

/** Feeds the prop values the layout renders, one render each, as the hook does. */
function run(start: FabOverride | null, props: boolean[]): boolean[] {
  let override = start
  return props.map((hidden) => {
    const r = resolveFabOverride(override, hidden)
    override = r.override
    return r.effectiveHidden
  })
}

describe('resolveFabOverride', () => {
  it('shows the prop when there is no override', () => {
    expect(run(null, [false, true, false])).toEqual([false, true, false])
  })

  it('hides at once, and the settings switch shows the button again after the refresh', () => {
    // X clicked while shown; the refresh brings hidden=true; the settings row turns it back on.
    const hide: FabOverride = { value: true, against: false, armed: true }
    expect(run(hide, [false, true, false])).toEqual([true, true, false])
  })

  it('ends the hide override once the server answered, so a later show is not undone', () => {
    const hide: FabOverride = { value: true, against: false, armed: true }
    const afterAnswer = resolveFabOverride(resolveFabOverride(hide, false).override, true)
    expect(afterAnswer.override).toBeNull()
  })

  it('keeps an undo shown when it comes before the hide refresh lands', () => {
    // Ångra before the hide's refresh: prop still false, then the hide's refresh
    // (true), then the undo's refresh (false), then hidden again from settings.
    const undo: FabOverride = { value: false, against: true, armed: false }
    expect(run(undo, [false, true, false, true])).toEqual([false, false, false, true])
  })

  it('keeps an undo shown when it comes after the hide refresh landed', () => {
    const undo: FabOverride = { value: false, against: true, armed: false }
    expect(run(undo, [true, false, true])).toEqual([false, false, true])
  })
})
