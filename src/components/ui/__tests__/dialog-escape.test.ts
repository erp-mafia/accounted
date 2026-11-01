import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEditTracker, holdEscapeWhileUnsaved } from '../dialog'

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

  it('holds an Escape pressed in the assistant beside a non-modal dialog', () => {
    withCompanionOpen(false)
    const event = {
      preventDefault: vi.fn(),
      target: { closest: (selector: string) => (selector === '[data-agent-ui]' ? {} : null) },
    } as unknown as KeyboardEvent
    holdEscapeWhileUnsaved(event, false)
    expect(event.preventDefault).toHaveBeenCalledOnce()
  })
})

/**
 * Follow-up of crm#1558: six more form dialogs held every Escape. Their
 * forms open filled (a bank row's lines, a momsrapport's settlement, a saved
 * employee or schedule, an inbox item's reading) or keep input outside one
 * form state, so "has content" cannot tell untouched from edited. The edit
 * tracker answers "changed anything since it opened".
 */
describe('createEditTracker', () => {
  const target = (isControl: boolean) => ({ closest: () => (isControl ? {} : null) }) as unknown as EventTarget

  it('starts untouched', () => {
    expect(createEditTracker().edited()).toBe(false)
  })

  it('turns on at a typed or picked value, not at a change Radix dispatches itself', () => {
    const tracker = createEditTracker()
    tracker.editProps.onChange({ nativeEvent: { isTrusted: false } as Event })
    expect(tracker.edited()).toBe(false)
    tracker.editProps.onChange({ nativeEvent: { isTrusted: true } as Event })
    expect(tracker.edited()).toBe(true)
  })

  it('turns on at a press of a control or list option, not at a click into a field', () => {
    const tracker = createEditTracker()
    tracker.editProps.onPointerDown({ target: target(false) })
    expect(tracker.edited()).toBe(false)
    tracker.editProps.onPointerDown({ target: target(true) })
    expect(tracker.edited()).toBe(true)
  })

  it('turns on at Enter or Space, not at Tab or Escape', () => {
    const tracker = createEditTracker()
    tracker.editProps.onKeyDown({ key: 'Tab' })
    tracker.editProps.onKeyDown({ key: 'Escape' })
    expect(tracker.edited()).toBe(false)
    tracker.editProps.onKeyDown({ key: 'Enter' })
    expect(tracker.edited()).toBe(true)

    const space = createEditTracker()
    space.editProps.onKeyDown({ key: ' ' })
    expect(space.edited()).toBe(true)
  })

  it('turns on at a double click (fill balance) and at a drop', () => {
    const doubleClick = createEditTracker()
    doubleClick.editProps.onDoubleClick()
    expect(doubleClick.edited()).toBe(true)

    const drop = createEditTracker()
    drop.editProps.onDrop()
    expect(drop.edited()).toBe(true)
  })

  it('starts untouched again when the dialog content mounts or unmounts', () => {
    const tracker = createEditTracker()
    tracker.editProps.onDrop()
    tracker.editProps.ref()
    expect(tracker.edited()).toBe(false)
  })
})

describe.each([
  ['NewSupplierInvoiceDialog', '../../supplier-invoices/NewSupplierInvoiceDialog.tsx', 'holdEscapeWhileUnsaved(e, edited())', '<div className="contents" {...editProps}>'],
  ['NewRecurringScheduleDialog', '../../invoices/NewRecurringScheduleDialog.tsx', 'holdEscapeWhileUnsaved(e, edited())', '<div className="contents" {...editProps}>'],
  ['NewEmployeeDialog', '../../salary/NewEmployeeDialog.tsx', 'holdEscapeWhileUnsaved(e, edited())', '<div className="contents" {...editProps}>'],
  ['employee edit dialog', '../../../app/(dashboard)/salary/employees/[id]/page.tsx', 'holdEscapeWhileUnsaved(e, editFormEdited())', '<form {...editFormProps} onSubmit={handleSave}'],
  ['TransactionBookingDialog', '../../transactions/TransactionBookingDialog.tsx', 'holdEscapeWhileUnsaved(e, edited() || held.files.length > 0 || held.inboxDocs.length > 0)', '<div className="space-y-4" {...editProps}>'],
  ['VatDeclarationView book dialog', '../../reports/lazy-views/VatDeclarationView.tsx', 'holdEscapeWhileUnsaved(e, edited())', '<div className="contents" {...editProps}>'],
])('%s Escape wiring', (_name, path, hold, tracked) => {
  const source = readFileSync(join(__dirname, path), 'utf8')

  it('lets Escape close it until something changed instead of always holding it', () => {
    expect(source).toContain(hold)
    expect(source).toContain(tracked)
    expect(source).not.toContain('onEscapeKeyDown={(e) => e.preventDefault()}')
  })

  it('still never closes on a backdrop click', () => {
    expect(source).toContain('onPointerDownOutside={(e) => e.preventDefault()}')
    expect(source).toContain('onInteractOutside={(e) => e.preventDefault()}')
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
