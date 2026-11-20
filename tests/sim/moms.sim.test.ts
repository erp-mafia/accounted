/**
 * Every momsdeklaration of the company's life against the sales and purchases
 * behind it, then against the ledger the settlement left behind.
 */
import { describe, expect, it } from 'vitest'
import { vatKey } from './answer-key'
import { loadSimCompany } from './company'

const { plan, key, doors } = loadSimCompany()

const quarters = plan.events.flatMap((event) =>
  event.type === 'vat_settlement' ? [{ label: vatKey(event.year, event.quarter), ...event }] : [],
)

describe.each(quarters)('momsdeklaration $label', ({ label, year, quarter }) => {
  const report = () => doors.call('gnubok_get_vat_report', { period_type: 'quarterly', year, period: quarter })

  it('has every ruta the sales and purchases give', async () => {
    const { rutor } = await report()
    const { filedNet: _filed, ...expected } = key.vat[label]
    const reported = Object.fromEntries(Object.keys(expected).map((box) => [box, rutor[box]]))
    expect(reported).toEqual(expected)
  })

  it('reports nothing in the rutor this company has no business in', async () => {
    const { rutor } = await report()
    const others = Object.entries(rutor).filter(([box, amount]) => !(box in key.vat[label]) && amount !== 0)
    expect(others).toEqual([])
  })

  it('states the whole kronor that are filed', async () => {
    const { summary } = await report()
    const { filedNet } = key.vat[label]
    expect(summary).toContain(`${Math.abs(filedNet)} kr`)
  })

  it('lists exactly the EU sales of ruta 39', async () => {
    const list = await doors.call('gnubok_get_periodisk_sammanstallning', { period_type: 'quarterly', year, period: quarter })
    expect(list.totals.services).toBe(Math.trunc(key.vat[label].ruta39))
  })
})
