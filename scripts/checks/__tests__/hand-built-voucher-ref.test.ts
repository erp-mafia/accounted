/**
 * Proof that the hand-built-voucher-ref ratchet counts the shapes its header
 * lists and leaves formatVoucher calls, comments and lookalikes alone.
 * Offending fixtures live only in these strings and in an OS temp directory
 * the end-to-end case creates and deletes.
 */
import { describe, it, expect, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  findHandBuiltVoucherRefs,
  findHandBuiltVoucherRefsInSource as scan,
} from '../hand-built-voucher-ref.mjs'

const tempDirs: string[] = []
afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
})

const lines = (source: string) => scan(source).map((f: { line: number }) => f.line)

describe('hand-built-voucher-ref: shapes counted', () => {
  it('counts template references with or without a hyphen or fallbacks', () => {
    expect(lines('const label = `${e.voucher_series}${e.voucher_number}`')).toEqual([1])
    expect(lines('return `${c.voucher_series}-${c.voucher_number}`')).toEqual([1])
    expect(lines("voucher: `${e.voucher_series ?? ''}${e.voucher_number ?? ''}`,")).toEqual([1])
    expect(lines("label: `${line.voucher_series ?? 'A'}${line.voucher_number} ${line.description}`")).toEqual([1])
  })

  it('counts camelCase fields and JSX text', () => {
    expect(lines('title: `${gap.voucherSeries}-${gap.voucherNumber}`,')).toEqual([1])
    expect(lines('<span>{voucher.voucher_series}-{voucher.voucher_number}</span>')).toEqual([1])
  })
})

describe('hand-built-voucher-ref: shapes left alone', () => {
  it('ignores formatVoucher calls', () => {
    expect(lines('const label = formatVoucher(e)')).toEqual([])
    expect(lines("voucher_label: formatVoucher(e, { separator: '-' }),")).toEqual([])
    expect(lines('<span>{formatVoucher(voucher)}</span>')).toEqual([])
  })

  it('ignores comments', () => {
    expect(lines('// a ref is `${x.voucher_series}${x.voucher_number}` by hand')).toEqual([])
    expect(lines(' * e.g. `${x.voucher_series}-${x.voucher_number}`')).toEqual([])
  })

  it('ignores the source system label, a different field', () => {
    expect(lines('? `${entry.source_voucher_series}${entry.source_voucher_number}`')).toEqual([])
  })
})

describe('hand-built-voucher-ref: end to end over a tree', () => {
  it('scans the source dirs, skips tests and the formatter, and sorts by file and line', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hand-built-voucher-ref-'))
    tempDirs.push(root)
    const write = (rel: string, body: string) => {
      const full = path.join(root, rel)
      fs.mkdirSync(path.dirname(full), { recursive: true })
      fs.writeFileSync(full, body)
    }
    write('lib/reports/x.ts', 'const a = 1\nconst v = `${e.voucher_series}${e.voucher_number}`\n')
    write('components/y.tsx', 'const t = `${g.voucherSeries}-${g.voucherNumber}`\n')
    write('lib/bookkeeping/voucher-series-resolver.ts', 'return `${series}${entry.voucher_number}` // `${e.voucher_series}${e.voucher_number}`\n')
    write('lib/reports/__tests__/x.test.ts', 'expect(`${e.voucher_series}${e.voucher_number}`)\n')
    write('scripts/z.ts', 'const v = `${e.voucher_series}${e.voucher_number}`\n')

    expect(findHandBuiltVoucherRefs(root)).toEqual([
      { file: 'components/y.tsx', line: 1, text: 'const t = `${g.voucherSeries}-${g.voucherNumber}`' },
      { file: 'lib/reports/x.ts', line: 2, text: 'const v = `${e.voucher_series}${e.voucher_number}`' },
    ])
  })
})
