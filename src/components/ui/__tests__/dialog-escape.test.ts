import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { holdEscapeWhileUnsaved } from '../dialog'

/**
 * crm#1558: "Ny verifikation" ignored Escape even with nothing typed in it.
 * The dialog held every Escape to protect a half-typed verifikat, which is
 * only worth anything once something is typed. Escape now closes an
 * untouched form dialog; it is held while there is unsaved input, and while
 * a portaled companion panel (the account list) is open, since that Escape
 * is meant for the panel.
 */
function escape(): KeyboardEvent {
  return { preventDefault: vi.fn() } as unknown as KeyboardEvent
}

function withCompanionOpen(open: boolean) {
  vi.stubGlobal('document', {
    querySelector: (selector: string) => (open && selector === '[data-dialog-companion]' ? {} : null),
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('holdEscapeWhileUnsaved', () => {
  it('lets Escape close a dialog with nothing typed', () => {
    withCompanionOpen(false)
    const event = escape()
    holdEscapeWhileUnsaved(event, false)
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('holds Escape while the form has unsaved input', () => {
    withCompanionOpen(false)
    const event = escape()
    holdEscapeWhileUnsaved(event, true)
    expect(event.preventDefault).toHaveBeenCalledOnce()
  })

  it('holds Escape while a companion panel is open, even with nothing typed', () => {
    withCompanionOpen(true)
    const event = escape()
    holdEscapeWhileUnsaved(event, false)
    expect(event.preventDefault).toHaveBeenCalledOnce()
  })
})

describe('NewJournalEntryDialog Escape wiring', () => {
  const source = readFileSync(
    join(__dirname, '../../bookkeeping/NewJournalEntryDialog.tsx'),
    'utf8',
  )

  it('decides Escape on the form\'s unsaved input instead of always holding it', () => {
    expect(source).toContain('onEscapeKeyDown={(e) => holdEscapeWhileUnsaved(e, hasUnsavedInput)}')
    expect(source).toContain('onHasContentChange={setHasUnsavedInput}')
    expect(source).not.toContain('onEscapeKeyDown={(e) => e.preventDefault()}')
  })

  it('still never closes on a backdrop click', () => {
    expect(source).toContain('onPointerDownOutside={(e) => e.preventDefault()}')
    expect(source).toContain('onInteractOutside={(e) => e.preventDefault()}')
  })
})
