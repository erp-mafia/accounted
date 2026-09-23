import { readFileSync } from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'

// The first act of onboarding is a fixed, non-scrolling scene: a step that
// outgrows its box has to give up space somewhere, and the one thing it must
// never give up is its own primary action (#2642). Those invariants live in a
// stylesheet, so this guards their shape, not their pixels: the geometry itself
// was verified by rendering journey.css at 900, 768, 620 and 500 px tall.
const dir = path.resolve(__dirname, '..')
const raw = readFileSync(path.join(dir, 'journey.css'), 'utf8')
const css = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ')
const journey = readFileSync(path.join(dir, 'OnboardingJourney.tsx'), 'utf8')
const address = readFileSync(path.join(dir, 'AddressFields.tsx'), 'utf8')

/** The declarations of the first rule whose selector list contains this text. */
function ruleFor(selector: string): string {
  const at = css.indexOf(selector)
  expect(at, `no rule for ${selector}`).toBeGreaterThan(-1)
  const open = css.indexOf('{', at)
  return css.slice(open + 1, css.indexOf('}', open))
}

/**
 * How many JSX elements enclose the `.jny-qactions` row inside what a
 * component returns, counting the returned fragment as level zero. Anything
 * above zero is a wrapper, and a wrapper is exactly what the sticky rule's
 * direct-child combinator cannot see through.
 */
function depthOfActionRow(source: string): number {
  const jsx = source
    .slice(source.indexOf('return ('), source.indexOf('jny-qactions'))
    // arrow functions in props carry a `>` that would end a tag early
    .replaceAll('=>', '==')
  let depth = -1 // the returned root itself is level zero
  for (const [tag] of jsx.matchAll(/<\/?[A-Za-z][^>]*?\/?>|<>|<\/>/g)) {
    if (tag.startsWith('</')) depth -= 1
    else if (!tag.endsWith('/>')) depth += 1
  }
  return depth
}

describe('journey step layout', () => {
  it('sizes the question area from its content so the balance spacer yields first', () => {
    // With flex-basis 0 the line inside .jny-center never overflows, so
    // .jny-balance keeps its 180px while the question area gets only the
    // leftover height: the step is then clipped with free space still on
    // screen below it, which is the reported bug.
    expect(ruleFor('.jny-qarea {')).not.toMatch(/flex:\s*1\s*;/)
    expect(ruleFor('.jny-qarea {')).toMatch(/flex:\s*(1 1 auto|auto)\s*;/)
  })

  it('seats the action row at the bottom of the step, in the first act only', () => {
    // Two things the selector has to keep. Direct child: sticky travels only
    // inside its own containing block, so a row one div deeper has nowhere to
    // go. Scoped to .jny-qarea: the books act reuses .jny-qstep with
    // `overflow: visible`, where the scrollport is the document and sticky
    // would pin the row to the browser window over the wizard it belongs to.
    const rule = ruleFor('.jny-qarea > .jny-qstep > .jny-qactions')
    expect(rule).toMatch(/position:\s*sticky/)
    expect(rule).toMatch(/bottom:\s*0/)
    expect(css).not.toMatch(/(^|[,{}]) ?\.jny-qstep > \.jny-qactions/)
    expect(ruleFor('.bks-qarea .jny-qstep')).toMatch(/overflow:\s*visible/)
  })

  it('keeps every action row of the first act a direct child of its step', () => {
    // The address step used to wrap its skip row in a div, which put it out of
    // the selector's reach and left that one step clipping itself. Any wrapper
    // does it, attributes or not, so count the depth rather than the markup:
    // the row has to sit at the top level of what the component returns, which
    // the step renders directly.
    expect(address).toContain('<div className="jny-qactions">')
    expect(depthOfActionRow(address)).toBe(0)
  })

  it('does not nest a second scroll box around the delayed action row', () => {
    // Reveal wraps the done scene's continue button. A nested .jny-qstep is a
    // scroll box inside a scroll box, which clips the row it wraps.
    const reveal = journey.slice(journey.indexOf('function Reveal('))
    const body = reveal.slice(0, reveal.indexOf('\nfunction ', 1))
    expect(body).toContain('jny-reveal')
    expect(body).not.toContain('jny-qstep')
  })
})
