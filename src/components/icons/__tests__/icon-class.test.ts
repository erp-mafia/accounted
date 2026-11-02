import { describe, expect, it } from 'vitest'
import { iconBoxProps } from '../icon-class'

const tokens = (className: string | undefined) => iconBoxProps(className, undefined, {}).className.split(/\s+/)

describe('iconBoxProps', () => {
  // The AGI panel's success line after the Skatteverket login: on a lucide
  // svg `inline` was harmless, on the span box it made h-3.5 w-3.5 inert and
  // the glyph filled the page.
  it('keeps a box that takes its size when the caller asks for inline', () => {
    const cls = tokens('mr-1 inline h-3.5 w-3.5 text-success')
    expect(cls).toContain('inline-flex')
    expect(cls).not.toContain('inline')
    expect(cls).toEqual(expect.arrayContaining(['h-3.5', 'w-3.5', 'mr-1', 'text-success']))
  })

  it('keeps the variant and important modifier on a rewritten inline', () => {
    expect(tokens('hidden md:inline h-4 w-4')).toEqual(expect.arrayContaining(['hidden', 'md:inline-flex']))
    expect(tokens('inline! h-4 w-4')).toContain('inline-flex!')
  })

  it('leaves an inline aimed at the glyph rather than the box alone', () => {
    expect(tokens('[&_svg]:inline h-4 w-4')).toContain('[&_svg]:inline')
  })

  it('leaves display classes that size the box alone', () => {
    expect(tokens('hidden sm:block h-4 w-4')).toEqual(expect.arrayContaining(['hidden', 'sm:block']))
    expect(tokens('inline-block h-4 w-4')).toContain('inline-block')
  })

  it('falls back to 24px only without a size utility', () => {
    expect(tokens(undefined)).toContain('size-6')
    expect(tokens('h-4 w-4')).not.toContain('size-6')
  })
})
