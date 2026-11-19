import { describe, expect, it } from 'vitest'
import { importsSieUndo } from '../imports'
import { posSalesDayBook } from '../pos-sales'

// crm#1938: a staged title is read by the person who approves it, so it
// names the thing (the day, the file), never the id the input points with.
describe('staged titles name the thing, not its id', () => {
  const DAY_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  const IMPORT_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

  it('a POS day is titled with its business date from the dry run', () => {
    const title = posSalesDayBook.mcp!.stage!.title({ day_id: DAY_ID }, { day_id: DAY_ID, business_date: '2026-11-14' })
    expect(title).toBe('Bokför dagskassa 2026-11-14')
  })

  it('a POS day without a readable date is titled without one', () => {
    const title = posSalesDayBook.mcp!.stage!.title({ day_id: DAY_ID }, { day_id: DAY_ID })
    expect(title).toBe('Bokför dagskassa')
    expect(title).not.toContain(DAY_ID.slice(0, 8))
  })

  it('an SIE import undo is titled with the file name, and with nothing when there is none', () => {
    const stage = importsSieUndo.mcp!.stage!
    expect(stage.title({ import_id: IMPORT_ID }, { import_id: IMPORT_ID, filename: 'bokslut-2025.se' })).toBe(
      'Ångra SIE-import: bokslut-2025.se',
    )
    expect(stage.title({ import_id: IMPORT_ID }, { import_id: IMPORT_ID, filename: null })).toBe('Ångra SIE-import')
  })
})
