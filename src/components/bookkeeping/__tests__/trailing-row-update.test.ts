import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const FORM_SRC = fs.readFileSync(path.resolve(__dirname, '../JournalEntryForm.tsx'), 'utf8')

/** The effect that keeps one blank row last in the konteringsrader. */
function trailingRowEffect(): string {
  const end = FORM_SRC.indexOf('}, [lines, makeBlankLine])')
  const start = FORM_SRC.lastIndexOf('useEffect(() => {', end)
  expect(end).toBeGreaterThan(-1)
  expect(start).toBeGreaterThan(-1)
  return FORM_SRC.slice(start, end)
}

describe('the trailing blank row in JournalEntryForm', () => {
  // The effect runs after every keystroke in a row. An update there that
  // changes nothing still leaves a render pending behind the keystroke, and
  // React counts each commit that leaves one pending as nested: keystrokes
  // handled before that render ran added up, and past 50 the next keystroke
  // threw "Maximum update depth exceeded" (React #185) in its own setLines,
  // losing the character typed into the radtext.
  it('makes no update while the last row is blank', () => {
    const effect = trailingRowEffect()
    const guard = effect.indexOf('if (!last || isBlankVoucherRow(last)) return')
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(effect.indexOf('setLines('))
  })

  it('appends only behind a started last row, read by the shared blank-row rule', () => {
    const effect = trailingRowEffect()
    expect(effect).toContain('isBlankVoucherRow(latest) ? prev : [...prev, makeBlankLine()]')
    expect(effect).not.toContain("account_number === ''")
  })
})
