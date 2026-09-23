import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Every way into an invoice line must work without a hardware keyboard.
 *
 * The unified entry row (#1654) replaced the explicit add-row button with a
 * ghost row that only Enter materialised; #2482 added Tab and a click, both
 * on `onMouseDown`. On Android neither exists: there is no Tab key, an open
 * IME composition swallows the action key as keyCode 229, and a tap's
 * synthesized mousedown arrives after the entry input's blur has closed the
 * popover, so the tap commits nothing. That is issue #2447: "not possible to
 * make an invoice from Android".
 *
 * This repo runs Vitest in the `node` environment and never renders
 * components, so, like the sibling booking-feedback-parity test, these are
 * file-level assertions: the commit targets must not regress to mouse-only.
 */

const read = (file: string) =>
  fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8')

const EDITOR_SRC = read('InvoiceEditor.tsx')
const COMBOBOX_SRC = read('ArticleCombobox.tsx')
const FLOW_SRC = read('invoice-editor-flow.ts')

const readMessages = (locale: 'sv' | 'en', namespace: string) =>
  (
    JSON.parse(
      fs.readFileSync(path.resolve(__dirname, `../../../messages/${locale}.json`), 'utf8'),
    ) as Record<string, Record<string, string>>
  )[namespace]

describe('entry row commit targets are pointer-driven', () => {
  it('has no mouse-only commit target left in either file', () => {
    // pointerdown fires for touch, pen and mouse alike; mousedown on touch is
    // a synthesized event that arrives after the blur teardown.
    expect(EDITOR_SRC).not.toContain('onMouseDown')
    expect(COMBOBOX_SRC).not.toContain('onMouseDown')
  })

  it('commits every ghost cell on pointerdown', () => {
    for (const cell of ['quantity', 'unit', 'unit_price', 'vat_rate']) {
      expect(
        EDITOR_SRC,
        `ghost cell ${cell}`,
      ).toMatch(
        new RegExp(
          `onPointerDown=\\{\\(e\\) => \\{[\\s\\S]{0,200}commitEntryToCell\\(entryQuery\\.trim\\(\\), '${cell}'\\)`,
        ),
      )
    }
    // All four, and no other handler shape reaching the same commit.
    expect(EDITOR_SRC.match(/commitEntryToCell\(entryQuery\.trim\(\)/g) ?? []).toHaveLength(4)
  })

  it('commits an article suggestion on pointerdown, in both article surfaces', () => {
    expect(EDITOR_SRC).toMatch(
      /onPointerDown=\{\(e\) => \{[\s\S]{0,400}commitEntryArticle\(a\.id\)/,
    )
    expect(COMBOBOX_SRC).toMatch(/onPointerDown=\{\(e\) => \{[\s\S]{0,400}select\(option\)/)
  })

  it('keeps the primary-button guard for mouse without blocking touch', () => {
    // `e.button !== 0` alone is wrong for touch: a touch pointerdown reports
    // button 0 on most browsers but not all, so the guard is mouse-scoped.
    expect(EDITOR_SRC).not.toMatch(/^\s*if \(e\.button !== 0\) return$/m)
    expect(COMBOBOX_SRC).not.toMatch(/^\s*if \(e\.button !== 0\) return$/m)
    expect(
      EDITOR_SRC.match(/if \(e\.pointerType === 'mouse' && e\.button !== 0\) return/g) ?? [],
    ).toHaveLength(5)
  })

  it('does not close the popover while focus is still inside it', () => {
    // The blur handler used to close unconditionally after 120ms, which is
    // the race a tap loses.
    expect(EDITOR_SRC).toContain('entryRootRef')
    expect(EDITOR_SRC).toMatch(/if \(next && entryRootRef\.current\?\.contains\(next\)\) return/)
    expect(EDITOR_SRC).toMatch(
      /if \(entryRootRef\.current\?\.contains\(document\.activeElement\)\) return/,
    )
    expect(COMBOBOX_SRC).toMatch(/if \(next && containerRef\.current\?\.contains\(next\)\) return/)
  })
})

describe('entry row survives an IME composition', () => {
  it('ignores a composing keydown and picks the press up on keyup', () => {
    expect(EDITOR_SRC).toMatch(/if \(isComposingKey\(e\.nativeEvent\)\) \{/)
    expect(EDITOR_SRC).toContain('function handleEntryKeyUp(')
    expect(EDITOR_SRC).toContain('onKeyUp={handleEntryKeyUp}')
    // The keyup path only runs right after a swallowed keydown, so a desktop
    // Enter cannot commit twice.
    expect(EDITOR_SRC).toMatch(/if \(!entryComposingKeyRef\.current\) return/)
  })

  it('reads both the standard and the legacy composition signal', () => {
    expect(FLOW_SRC).toContain('export function isComposingKey(')
    expect(FLOW_SRC).toContain('event.keyCode === 229')
    expect(FLOW_SRC).toContain("event.key === 'Unidentified'")
    expect(FLOW_SRC).toMatch(/if \(input\.composing\) return \{ kind: 'none' \}/)
  })

  it('labels the Android action key', () => {
    expect(EDITOR_SRC).toContain('enterKeyHint="done"')
  })
})

describe('a keyboard-free path into a row exists and is labelled', () => {
  it('renders an add-row button that materialises the entry row', () => {
    expect(EDITOR_SRC).toContain('function addEntryRow(')
    expect(EDITOR_SRC).toContain("onClick={addEntryRow}")
    expect(EDITOR_SRC).toContain("+ {t('add_row')}")
    // It shares the commit rule with Enter rather than forking it.
    expect(EDITOR_SRC).toContain('function runEntryAction(')
  })

  it('ships the strings in both locales and no longer promises keys only', () => {
    for (const locale of ['sv', 'en'] as const) {
      const messages = readMessages(locale, 'invoice_editor')
      expect(messages.add_row, `${locale}.invoice_editor.add_row`).toBeTruthy()
      for (const key of ['entry_hint_matches', 'entry_hint_free'] as const) {
        expect(messages[key], `${locale}.invoice_editor.${key}`).toBeTruthy()
        // Tab does not exist on a touch keyboard: a hint that names it as the
        // way forward is the copy half of issue #2447.
        expect(messages[key], `${locale}.invoice_editor.${key}`).not.toMatch(/\bTab\b/)
      }
    }
  })
})
