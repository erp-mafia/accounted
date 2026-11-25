/**
 * The anläggningsnot of each closed year against the answer key: the
 * Inventarier post opens with what the books held at the start of the year
 * and shows what they booked in it, also in the year the register took over
 * an asset depreciated by hand until the middle of the year, with what was
 * already depreciated stated per that day.
 */
import { describe, expect, it } from 'vitest'
import { loadSimCompany } from './company'

const { state, plan, key, doors } = loadSimCompany()

interface NoteRow { key: string; amount: number }
interface NoteTable { post: string | null; blocks: Array<{ key: string; rows: NoteRow[] }> }

const closedYears = plan.events.flatMap((event) => (event.type === 'year_end' ? [event.year] : []))

async function inventarier(year: number) {
  const { report } = await doors.call('gnubok_preview_arsredovisning', { fiscal_period_id: state.fiscalPeriods[year] })
  const note = (report.noter as Array<{ fixedAssets?: NoteTable[] }>).find((candidate) => candidate.fixedAssets)
  const table = note?.fixedAssets?.find((candidate) => candidate.post === 'InventarierVerktygInstallationer')
  if (!table) throw new Error(`no Inventarier table in ${year}`)
  const row = (rowKey: string) => table.blocks.flatMap((block) => block.rows).find((candidate) => candidate.key === rowKey)?.amount ?? 0
  const warnings = (report.warnings as string[]).filter((warning) => warning.startsWith('Anläggningsnot'))
  return { row, warnings }
}

function expectKronor(actual: number, expected: number): void {
  expect(Math.abs(actual - expected), `${actual} against ${expected}`).toBeLessThanOrEqual(1)
}

describe.each(closedYears)('anläggningsnoten %i, Inventarier', (year) => {
  it('opens with what the books held and shows what they booked in the year', async () => {
    const { row, warnings } = await inventarier(year)
    const k = key.fixedAssetNote[year]
    expectKronor(row('cost.opening'), k.costOpening)
    expectKronor(row('cost.inkop'), k.purchases)
    expectKronor(row('cost.closing'), k.costOpening + k.purchases)
    expectKronor(row('depreciation.opening'), k.accumulatedOpening)
    expectKronor(row('depreciation.arets'), k.depreciation)
    expectKronor(row('depreciation.closing'), k.accumulatedOpening + k.depreciation)
    expect(warnings).toEqual([])
  })
})
