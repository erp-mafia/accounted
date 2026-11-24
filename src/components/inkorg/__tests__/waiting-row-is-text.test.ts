/**
 * A row of Behöver dig that only waits for the person is the list's normal
 * state, so it reads as muted text. A chip is kept for the rows that deviate
 * (looks paid, overdue, could not be read): the same chip on every row says
 * nothing. Components are not rendered in this suite (vitest runs in `node`),
 * so the wiring is pinned on the component source.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const source = fs.readFileSync(path.resolve(__dirname, '../InkorgList.tsx'), 'utf8')

describe('Inkorg row status', () => {
  it('the waiting state is muted text, not a chip', () => {
    const from = source.indexOf("status.kind === 'waiting'")
    const to = source.indexOf("status.kind === 'reading'")
    expect(from).toBeGreaterThan(-1)
    expect(to).toBeGreaterThan(from)
    const branch = source.slice(from, to)
    expect(branch).toContain("t('status_waiting')")
    expect(branch).toContain('text-muted-foreground')
    expect(branch).not.toContain('<Badge')
  })

  it('a row that deviates keeps its chip', () => {
    expect(source).toMatch(/status\.kind === 'looks_paid' \? \(\s*<Badge variant="warning">/)
    expect(source).toMatch(/status\.kind === 'unreadable' \? \(\s*<Badge variant="destructive">/)
  })
})
