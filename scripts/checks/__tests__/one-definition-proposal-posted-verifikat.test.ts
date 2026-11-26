/**
 * The proposal-posted-verifikat guard catches a posted verifikat read off a
 * staged preview by name, or a registration worked out beside the approval,
 * and leaves the reader's own calls and other uses of the same words alone.
 */
import { describe, it, expect } from 'vitest'
import { findRuleLines } from '../one-definition.mjs'
import rule from '../one-definition/proposal-posted-verifikat.mjs'

const hits = (line: string) => findRuleLines(line, rule).length > 0

describe('proposal-posted-verifikat', () => {
  it.each([
    'const sale = record(data.sale_entry).lines',
    'const rows = preview.expected_lines ?? []',
    'const lines = (op.preview_data?.corrected as Entry).lines',
    'const posted = [record(data.correction), record(data.reversal)].find((entry) => isPostingLines(entry.lines))',
    'const lines = supplierInvoiceRegistrationLines(header, items, supplierType, \'\', chart)',
  ])('catches %s', (line) => {
    expect(hits(line)).toBe(true)
  })

  it.each([
    'const posted = postedVerifikat(op.preview_data)',
    '{preview.verifikat.map(({ lines, listed }, index) => (',
    'row.storno -= net',
    'const answer = await askBuiltVerifikat(op).answer',
  ])('leaves %s', (line) => {
    expect(hits(line)).toBe(false)
  })
})
