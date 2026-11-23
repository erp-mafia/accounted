/**
 * The guard for the row labels of the specification of changes in equity
 * catches a second table of labels, and leaves a table that maps the kinds
 * to something else (the taxonomy's concept names) alone.
 */
import { describe, expect, it } from 'vitest'
import { findRuleLines } from '../one-definition.mjs'
import rule from '../one-definition/equity-movement-row-label.mjs'

const hits = (line: string) => findRuleLines(line, rule).length > 0

describe('one-definition: equity-movement-row-label', () => {
  it.each([
    // The table the iXBRL adapter kept, which the rule was written for.
    "  rattelse_av_fel: 'Effekt av rättelse av fel',",
    "  aktieagartillskott: 'Erhållna tillskott',",
    "  aterbetalt_tillskott: 'Återbetalda tillskott',",
    "  andra_vardeoverforingar: 'Andra värdeöverföringar till ägare',",
    '  ovriga_direkt_mot_eget_kapital: "Övriga poster redovisade direkt mot eget kapital",',
    "  insatser_inbetalda: 'Inbetalda insatser',",
  ])('flags a label written beside a kind: %s', (line) => {
    expect(hits(line)).toBe(true)
  })

  it.each([
    // The kinds mapped to the taxonomy's concept names (document/equity-table.ts).
    "  aktieagartillskott: 'ErhallnaAktieagartillskott',",
    "  rattelse_av_fel: 'EffektRattelseFel',",
    // A kind as a value, and the label asked from its home.
    "    return 'aterbetalt_tillskott'",
    "  { kind: 'insatser_inbetalda', label: equityMovementLabel('insatser_inbetalda') },",
  ])('leaves alone: %s', (line) => {
    expect(hits(line)).toBe(false)
  })
})
