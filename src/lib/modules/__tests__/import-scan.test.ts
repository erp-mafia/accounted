import { describe, expect, it } from 'vitest'
import { boundaryReport, extractRuntimeSpecifiers } from './import-scan'

const specs = (source: string) => extractRuntimeSpecifiers(source).map((s) => s.specifier)

describe('extractRuntimeSpecifiers', () => {
  it('counts value imports, side-effect imports, re-exports, dynamic imports and require', () => {
    const source = [
      `import a from '@/lib/a'`,
      `import { b, c } from "@/lib/b"`,
      `import * as d from './d'`,
      `import e, { type E } from '../e'`,
      `import {`,
      `  f,`,
      `  type F,`,
      `} from '@/lib/f'`,
      `import '@/lib/side-effect'`,
      `export { g } from '@/lib/g'`,
      `export * from './h'`,
      `const i = await import('@/lib/i')`,
      `void import('@/lib/j').then((m) => m.run())`,
      `const k = require('@/lib/k')`,
    ].join('\n')
    expect(specs(source)).toEqual([
      '@/lib/a',
      '@/lib/b',
      './d',
      '../e',
      '@/lib/f',
      '@/lib/g',
      './h',
      '@/lib/side-effect',
      '@/lib/i',
      '@/lib/j',
      '@/lib/k',
    ])
  })

  it('skips type-only imports and exports, including type-position import()', () => {
    const source = [
      `import type { A } from '@/lib/a'`,
      `import type B from '@/lib/b'`,
      `import { type C, type D } from '@/lib/c'`,
      `export type { E } from '@/lib/e'`,
      `export type * from '@/lib/f'`,
      `type G = import('@/lib/g').G`,
      `type H = typeof import('@/lib/h')`,
    ].join('\n')
    expect(specs(source)).toEqual([])
  })

  it('ignores imports spelled in comments', () => {
    const source = [
      `/**`,
      ` * import { x } from '@/lib/doc-example'`,
      ` * await import('@/lib/doc-dynamic')`,
      ` */`,
      `// import y from '@/lib/commented-out'`,
      `// const z = await import('@/lib/commented-dynamic')`,
    ].join('\n')
    expect(specs(source)).toEqual([])
  })

  it('does not run a local export into the next import', () => {
    const source = [`export const value = 1`, `import later from '@/lib/later'`].join('\n')
    expect(specs(source)).toEqual(['@/lib/later'])
  })

  it('reports 1-based line numbers', () => {
    const lines = extractRuntimeSpecifiers(`// header\n\nimport x from '@/lib/x'\n`)
    expect(lines).toEqual([{ specifier: '@/lib/x', line: 3 }])
  })
})

describe('boundaryReport', () => {
  it('counts kernel-to-block, undeclared block-to-block and undeclared kernel-to-kernel edges, and nothing else', () => {
    const report = boundaryReport([
      { from: 'bookkeeping/engine.ts', to: 'invoices/vat-rules', line: 1 }, // kernel -> block
      { from: 'bookkeeping/engine.ts', to: 'invoices/rounding', line: 2 }, // kernel -> block
      { from: 'invoices/book-service.ts', to: 'bookkeeping/engine', line: 3 }, // block -> kernel: allowed
      { from: 'bookkeeping/engine.ts', to: 'auth/claims', line: 4 }, // ledger -> platform: declared
      { from: 'auth/api-keys.ts', to: 'company/active-company', line: 10 }, // platform -> ledger: undeclared
      { from: 'payments/batch-service.ts', to: 'supplier-invoices/create', line: 5 }, // declared dependency
      { from: 'invoices/vat.ts', to: 'vat/gross-split', line: 6 }, // undeclared
      { from: 'invoices/x.ts', to: 'invoices/y', line: 7 }, // same module
      { from: 'invoices/x.ts', to: 'supabase/server', line: 8 }, // into infrastructure
      { from: 'operations/invoices.ts', to: 'invoices/y', line: 9 }, // from infrastructure
    ])
    expect(report.kernelToBlock).toEqual({ 'ledger -> invoicing': 2 })
    expect(report.undeclaredBlockToBlock).toEqual({ 'invoicing -> vat': 1 })
    expect(report.undeclaredKernelToKernel).toEqual({ 'platform -> ledger': 1 })
    expect(report.edgesByKey['ledger -> invoicing']).toHaveLength(2)
  })
})
