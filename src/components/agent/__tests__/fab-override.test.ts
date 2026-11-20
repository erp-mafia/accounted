import { describe, expect, it } from 'vitest'
import { resolveFabOverride, settleUndoOverride, type FabOverride } from '../fab-override'

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

  it('ends an undo that never saw "hidden" once its save landed, so a later hide from settings holds', () => {
    // Ångra before the hide's refresh, which rendered after the undo's write:
    // the prop stays false, then the settings row hides the button.
    const undo: FabOverride = { value: false, against: true, armed: false }
    const beforeSave = resolveFabOverride(undo, false)
    expect(beforeSave.effectiveHidden).toBe(false)
    expect(run(settleUndoOverride(beforeSave.override), [false, true])).toEqual([false, true])
    // Without the settle, the override armed on that hide and kept the button shown.
    expect(run(beforeSave.override, [false, true])).toEqual([false, false])
  })

  it('keeps an undo that saw "hidden" when its save lands, until its refresh brings the prop back', () => {
    const undo: FabOverride = { value: false, against: true, armed: false }
    const seen = resolveFabOverride(undo, true)
    expect(seen.effectiveHidden).toBe(false)
    expect(run(settleUndoOverride(seen.override), [true, false, true])).toEqual([false, false, true])
  })
})
