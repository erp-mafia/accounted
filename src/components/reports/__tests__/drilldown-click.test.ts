import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import type { MouseEvent } from 'react'
import { accountDrilldownClick } from '../drilldown-click'

/**
 * Selecting text in a report must not open the account (crm#1123).
 *
 * Dragging across an amount to copy it fires a click on mouseup. The
 * Resultatrapport row ignored that click, but its check was written inline in
 * that one row, so the Balansrapport, the Resultaträkning/Balansräkning tables
 * and the Saldobalans account cells, each with a handler of its own, still
 * drilled into the account.
 *
 * The first block runs the shared handler; the second pins that every
 * drill-down in the report components goes through it. This repo runs Vitest
 * in the node environment and never renders components, so the pin reads the
 * source through the TypeScript AST.
 */

afterEach(() => {
  vi.unstubAllGlobals()
})

/**
 * A stand-in for window.getSelection(). `touches` are the nodes the selection
 * intersects, `covers` the ones it contains whole: containsNode answers from
 * one or the other by allowPartialContainment, as the DOM does. An empty text
 * is a collapsed selection, the state a plain click leaves behind.
 */
function stubSelection(
  selection: { text: string; touches?: Element[]; covers?: Element[] } | null,
) {
  vi.stubGlobal('window', {
    getSelection: () =>
      selection && {
        isCollapsed: selection.text === '',
        toString: () => selection.text,
        containsNode: (node: Node, allowPartialContainment = false) =>
          (allowPartialContainment ? selection.touches ?? [] : selection.covers ?? []).includes(
            node as Element,
          ),
      },
  })
}

/**
 * Clicks the drill-down on `currentTarget`, the row or cell carrying the
 * handler. `target` is where the click landed: the row itself unless given.
 */
function clickOn(currentTarget: Element, target: Element = currentTarget) {
  const navigate = vi.fn()
  accountDrilldownClick(navigate, '1930')({ currentTarget, target } as unknown as MouseEvent)
  return navigate
}

const row = { id: 'clicked row' } as unknown as Element
const otherRow = { id: 'another row' } as unknown as Element
// The AccountNumber tooltip renders inside the row in React but is portalled
// to document.body, so React hands its clicks to the row's handler while the
// DOM keeps it outside the row.
const tooltip = { id: 'account tooltip, portalled out of the row' } as unknown as Element

describe('accountDrilldownClick', () => {
  it('opens the account on a plain click', () => {
    stubSelection({ text: '' })
    expect(clickOn(row)).toHaveBeenCalledWith('1930')
  })

  it('opens the account when the document has no selection', () => {
    stubSelection(null)
    expect(clickOn(row)).toHaveBeenCalledWith('1930')
  })

  it('stays on the report when the click ends a drag across text in the row', () => {
    // A drag over one amount intersects the row without containing all of it.
    stubSelection({ text: '12 500,00', touches: [row] })
    expect(clickOn(row)).not.toHaveBeenCalled()
  })

  it('opens the account on a plain click on the account tooltip', () => {
    stubSelection({ text: '' })
    expect(clickOn(row, tooltip)).toHaveBeenCalledWith('1930')
  })

  it('stays on the report when the click ends a drag across text in the account tooltip', () => {
    stubSelection({ text: 'Kassa', touches: [tooltip] })
    expect(clickOn(row, tooltip)).not.toHaveBeenCalled()
  })

  it('opens the account when the selection is elsewhere on the page', () => {
    stubSelection({ text: 'Kassa', touches: [otherRow], covers: [otherRow] })
    expect(clickOn(row)).toHaveBeenCalledWith('1930')
  })

  it('treats a whitespace-only selection as a plain click', () => {
    stubSelection({ text: '\n\t ', touches: [row] })
    expect(clickOn(row)).toHaveBeenCalledWith('1930')
  })
})

const REPORTS = path.resolve(__dirname, '..')
const reportComponents = fs
  .readdirSync(REPORTS, { recursive: true, encoding: 'utf8' })
  .filter((file) => file.endsWith('.tsx') && !file.split(path.sep).includes('__tests__'))
  .map((file) =>
    ts.createSourceFile(
      file,
      fs.readFileSync(path.join(REPORTS, file), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    ),
  )

/** Every onClick in the report components that reaches onNavigateToAccount, by enclosing component. */
function drilldownClicks(): { file: string; component: string; handler: string }[] {
  const found: { file: string; component: string; handler: string }[] = []
  for (const source of reportComponents) {
    const visit = (node: ts.Node) => {
      const handler =
        ts.isJsxAttribute(node) && node.name.getText(source) === 'onClick'
          ? node.initializer?.getText(source)
          : undefined
      if (handler?.includes('onNavigateToAccount')) {
        let fn: ts.Node | undefined = node.parent
        while (fn && !ts.isFunctionDeclaration(fn)) fn = fn.parent
        found.push({
          file: source.fileName,
          component: fn && ts.isFunctionDeclaration(fn) && fn.name ? fn.name.text : '(anonymous)',
          handler,
        })
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return found
}

describe('report components drill into an account only through accountDrilldownClick', () => {
  const clicks = drilldownClicks()

  it('finds the drill-down of every report with clickable accounts', () => {
    expect([...new Set(clicks.map((c) => c.component))]).toEqual(
      expect.arrayContaining([
        'TrialBalanceSimplifiedRow',
        'TrialBalanceDetailedRow',
        'ResultatrapportView',
        'BalansrapportSectionRows',
        'ReportSectionTable',
      ]),
    )
  })

  it('never calls onNavigateToAccount straight from a click', () => {
    const unguarded = clicks.filter(
      (c) =>
        /\bonNavigateToAccount\(/.test(c.handler) ||
        !c.handler.includes('accountDrilldownClick(onNavigateToAccount, '),
    )
    expect(unguarded).toEqual([])
  })
})
