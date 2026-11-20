/**
 * Proof that the duplicate-block guard finds a block copied between files,
 * merges it into one block with both locations, and leaves alone what is not
 * a cross-file copy: short repeats, copies inside one file, tests and
 * generated files. Fixtures live in an OS temp directory the test deletes.
 */
import { describe, it, expect, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  findDuplicateBlocks,
  formatDuplicateBlock,
  normalizeSource,
  WINDOW,
} from '../duplicate-blocks.mjs'

const tempDirs: string[] = []
afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
})

function fixture(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'duplicate-blocks-'))
  tempDirs.push(root)
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
  }
  return root
}

/** `n` distinct meaningful lines, named so two calls with one prefix copy each other. */
function body(prefix: string, n: number) {
  return Array.from({ length: n }, (_, i) => `const ${prefix}${i} = compute${i}(input, ${i})`).join('\n')
}

describe('duplicate-block guard', () => {
  it('flags a block copied between two files with both locations, merged into one block', () => {
    const copied = body('shared', WINDOW + 5)
    const root = fixture({
      'lib/a.ts': `import { x } from './x'\n\n${copied}\n`,
      'lib/b.ts': `// a different preamble\nexport const unrelated = 1\n${copied}\n`,
    })
    const { pairs, blocks } = findDuplicateBlocks(root)
    expect(pairs).toEqual({ 'lib/a.ts <-> lib/b.ts': WINDOW + 5 })
    expect(blocks).toEqual([
      { a: 'lib/a.ts', aLine: 3, aEnd: 3 + WINDOW + 4, b: 'lib/b.ts', bLine: 3, bEnd: 3 + WINDOW + 4, lines: WINDOW + 5 },
    ])
    expect(formatDuplicateBlock(blocks[0])).toBe(
      `Duplicated block (${WINDOW + 5} lines) in lib/a.ts:3 also in lib/b.ts:3. ` +
        'Reuse or extract the shared code (search for an existing helper first); do not copy.',
    )
  })

  it('sees through comments, blank lines, imports and indentation inside the copy', () => {
    const lines = body('same', WINDOW).split('\n')
    const noisy = lines.map((l, i) => (i % 3 === 0 ? `\n  // note ${i}\n      ${l}` : `\t${l}`)).join('\n')
    const root = fixture({
      'components/A.tsx': lines.join('\n'),
      'components/B.tsx': `import {\n  a,\n  b,\n} from 'z'\n${noisy}\n`,
    })
    expect(Object.keys(findDuplicateBlocks(root).pairs)).toEqual(['components/A.tsx <-> components/B.tsx'])
  })

  it('leaves short repeats, copies inside one file, tests and generated files alone', () => {
    const copied = body('dup', WINDOW + 2)
    const root = fixture({
      'lib/short-a.ts': body('short', WINDOW - 1),
      'lib/short-b.ts': body('short', WINDOW - 1),
      'lib/self.ts': `${copied}\nexport const gap = 1\n${copied}\n`,
      'lib/__tests__/x.test.ts': copied,
      'lib/y.test.ts': copied,
      'lib/_generated/registry.ts': copied,
      'lib/gen.ts': `/**\n * AUTO-GENERATED: do not edit by hand.\n */\n${copied}`,
    })
    expect(findDuplicateBlocks(root)).toEqual({ pairs: {}, blocks: [] })
  })

  it('normalises to meaningful lines only', () => {
    const src = [
      `'use client'`,
      `import { a } from 'a'`,
      `import {`,
      `  b,`,
      `} from 'b'`,
      `export { c } from 'c'`,
      `/**`,
      ` * doc`,
      ` */`,
      `// comment`,
      ``,
      `const   x  =   1`,
      `})`,
      `</div>`,
      `return <Row value={x} />`,
    ].join('\n')
    expect(normalizeSource(src)).toEqual([
      { text: 'const x = 1', line: 12 },
      { text: 'return <Row value={x} />', line: 15 },
    ])
  })
})
