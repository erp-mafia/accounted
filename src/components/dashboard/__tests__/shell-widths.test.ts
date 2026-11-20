/**
 * The shell's widths are each written once (app/globals.css): the rail
 * (--rail-w) and the area sidebar (--side-w) as plain lengths, and --nav-w,
 * where the page starts, as their sum. A second number for the rail (a pixel
 * --nav-w, another --rail-w) is how the sidebar, the floating bars and the
 * assistant panel fall out of step with the rail the next time it changes
 * width: on 2026-11-17 the rail went from 60px to 96px and --nav-w held the
 * old sum in two places.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { navWidthFromParts } from '@/lib/agent-panel/geometry'

const globals = readFileSync(join(__dirname, '../../../app/globals.css'), 'utf8')

/** Every value the stylesheet declares for a custom property, in file order. */
const declared = (property: string) =>
  [...globals.matchAll(new RegExp(`^\\s*${property}:\\s*([^;]+);`, 'gm'))].map((match) => match[1].trim())

describe('the shell widths in globals.css', () => {
  it('writes the rail width once, as a plain length', () => {
    expect(declared('--rail-w')).toEqual([expect.stringMatching(/^\d+px$/)])
  })

  it('writes the sidebar width as plain lengths: the base and the wide-window override', () => {
    const widths = declared('--side-w')
    expect(widths).toHaveLength(2)
    for (const width of widths) expect(width).toMatch(/^\d+px$/)
  })

  it('derives --nav-w from the two, once, and never as a number', () => {
    expect(declared('--nav-w')).toEqual(['calc(var(--rail-w) + var(--side-w))'])
  })

  it('hands the assistant panel lengths it can add', () => {
    const [rail] = declared('--rail-w')
    for (const side of declared('--side-w')) {
      expect(navWidthFromParts(rail, side)).toBe(Number.parseInt(rail, 10) + Number.parseInt(side, 10))
    }
  })
})
