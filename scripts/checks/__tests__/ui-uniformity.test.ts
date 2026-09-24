/**
 * Proof that the ui-uniformity guard flags each drifted design-system pattern
 * and leaves the sanctioned vocabulary alone. Fixtures are inline source
 * strings run through findInSource; one filesystem case covers the walker.
 */
import { describe, it, expect, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { classifyToken, findInSource, findUiUniformityFindings } from '../ui-uniformity.mjs'

const rules = (src: string, file = 'components/x/Thing.tsx') =>
  findInSource(file, src).map((f: { rule: string }) => f.rule)

describe('classifyToken', () => {
  it.each([
    ['duration-200', 'off-token-duration'],
    ['md:duration-500', 'off-token-duration'],
    ['duration-[250ms]', 'off-token-duration'],
    ['ease-[cubic-bezier(0.32,0.72,0,1)]', 'literal-easing'],
    ['transition-all', 'transition-all'],
    ['shadow-lg', 'tailwind-shadow'],
    ['data-[state=active]:shadow-sm', 'tailwind-shadow'],
    ['border-border/60', 'faded-border'],
    ['border-b-border/40', 'faded-border'],
    ['hover:bg-muted/50', 'hover-tint'],
    ['hover:bg-secondary', 'hover-tint'],
    ['bg-slate-50', 'raw-palette'],
    ['group-[.destructive]:text-red-300', 'raw-palette'],
    ['bg-[#0f172a]', 'raw-palette'],
    ['focus:ring-2', 'focus-not-visible'],
    ['text-[10px]', 'off-scale-text'],
    ['[&_th]:text-[10.5px]', 'off-scale-text'],
    ['animate-bounce', 'decorative-animation'],
    ['animate-scale-in', 'decorative-animation'],
  ])('%s -> %s', (token, rule) => {
    expect(classifyToken(token, 'components/x/Thing.tsx')).toBe(rule)
  })

  it.each([
    'duration-150',
    'duration-300',
    'data-[state=closed]:duration-150',
    'ease-drawer',
    'ease-emphasized',
    'transition-colors',
    'shadow-[var(--shadow-md)]',
    'border-border',
    'hover:bg-secondary/35',
    'hover:bg-secondary/60',
    'bg-black/50',
    'text-destructive',
    'focus-visible:ring-2',
    'focus:ring-0',
    'text-[11px]',
    'text-[12.5px]',
    'text-[13px]',
    'text-[15px]',
    'text-xs',
    'animate-spin',
    'animate-typing-dot',
  ])('allows %s', (token) => {
    expect(classifyToken(token, 'components/x/Thing.tsx')).toBeNull()
  })

  it('lets the button primitive keep its own hover states', () => {
    expect(classifyToken('hover:bg-secondary', 'components/ui/button.tsx')).toBeNull()
  })
})

describe('findInSource', () => {
  it('flags a height override on a Button, including through cn()', () => {
    expect(rules(`const a = <Button className="h-7 px-2">x</Button>`)).toEqual(['button-height-override'])
    expect(rules(`const a = <Button className={cn('min-h-11', busy && 'w-full')}>x</Button>`)).toEqual([
      'button-height-override',
    ])
  })

  it('allows h-auto and width classes on a Button, and heights on other elements', () => {
    expect(rules(`const a = <Button variant="link" className="h-auto w-full">x</Button>`)).toEqual([])
    expect(rules(`const a = <div className="h-7">x</div>`)).toEqual([])
  })

  it('flags a Loader2 rendered inside a Button', () => {
    expect(
      rules(`const a = <Button disabled={busy}>{busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Spara</Button>`),
    ).toEqual(['button-spinner'])
    expect(rules(`const a = <Button loading={busy}>Spara</Button>`)).toEqual([])
    expect(rules(`const a = <div>{busy && <Loader2 className="h-4 w-4 animate-spin" />}</div>`)).toEqual([])
  })

  it('flags native browser dialogs', () => {
    expect(rules(`if (!window.confirm('Säker?')) return`)).toEqual(['native-dialog'])
    expect(rules(`alert('x')`)).toEqual(['native-dialog'])
    expect(rules(`const ok = await confirm({ title: 'x' })`)).toEqual([])
  })

  it('reads class strings, not comments or import paths', () => {
    expect(rules(`// the old list used shadow-lg and duration-200\nimport x from './shadow-lg'`)).toEqual([])
  })

  it('reads template literal class lists', () => {
    expect(rules('const c = `flex ${open ? "rotate-90" : ""} transition-all`')).toEqual(['transition-all'])
  })
})

describe('findUiUniformityFindings', () => {
  const dirs: string[] = []
  afterAll(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })))

  it('walks app, components and extensions and skips tests', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-uniformity-'))
    dirs.push(root)
    const write = (rel: string, body: string) => {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
      fs.writeFileSync(path.join(root, rel), body)
    }
    write('components/a/A.tsx', `export const A = () => <div className="shadow-md" />\n`)
    write('app/p/page.tsx', `export default () => <div className="duration-500" />\n`)
    write('components/a/__tests__/A.test.tsx', `const x = <div className="shadow-md" />\n`)
    write('lib/x.ts', `export const c = 'shadow-md'\n`)
    const found = findUiUniformityFindings(root)
    expect(found.map((f: { where: string; rule: string }) => `${f.where} ${f.rule}`)).toEqual([
      'app/p/page.tsx:1 off-token-duration',
      'components/a/A.tsx:1 tailwind-shadow',
    ])
  })
})
