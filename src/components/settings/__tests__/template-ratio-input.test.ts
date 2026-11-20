import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The share (andel) input in the mall editor took only multiples of 0.1
 * (step="0.1"), so the browser refused to submit a template with
 * särskild löneskatt 0.2426 on its own ("Ange ett giltigt värde") before
 * Accounted saw it (crm#1657). Neither the API schema nor applyTemplate
 * limits the decimals: the input must not either.
 */

const source = readFileSync(join(__dirname, '..', 'TemplateForm.tsx'), 'utf8')

function ratioInput(): string {
  const anchor = source.indexOf("aria-label={t('ratio_label')}")
  expect(anchor).toBeGreaterThan(-1)
  const start = source.lastIndexOf('<Input', anchor)
  const end = source.indexOf('/>', anchor)
  return source.slice(start, end)
}

describe('TemplateForm share input (crm#1657)', () => {
  it('accepts any decimal: no stepped constraint the browser enforces', () => {
    const input = ratioInput()
    expect(input).toContain('step="any"')
    expect(input).not.toMatch(/step="0?\.\d+"/)
  })

  it('keeps the 0 to 10 bounds the API schema enforces', () => {
    const input = ratioInput()
    expect(input).toContain('min={0}')
    expect(input).toContain('max={10}')
  })

  it('is wide enough to show four decimals', () => {
    expect(ratioInput()).not.toContain('w-16')
  })
})
