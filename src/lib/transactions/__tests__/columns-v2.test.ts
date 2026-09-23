import { describe, it, expect } from 'vitest'
import { resolveTxColumns, TX_COLUMN_IDS } from '../columns-v2'

describe('resolveTxColumns', () => {
  it('shows every column by default', () => {
    expect([...resolveTxColumns()]).toEqual([...TX_COLUMN_IDS])
    expect([...resolveTxColumns(null)]).toEqual([...TX_COLUMN_IDS])
  })

  it('hides optional columns the user turned off, in fixed order', () => {
    const visible = resolveTxColumns({ hidden: ['account', 'date'] })
    expect([...visible]).toEqual(['description', 'category', 'amount', 'status'])
  })

  it('never hides Beskrivning or Status', () => {
    const visible = resolveTxColumns({ hidden: ['description', 'status', 'amount'] })
    expect(visible.has('description')).toBe(true)
    expect(visible.has('status')).toBe(true)
    expect(visible.has('amount')).toBe(false)
  })

  it('ignores unknown ids from an older preference bag', () => {
    const visible = resolveTxColumns({ hidden: ['klass', 'entity', 'category'] })
    expect([...visible]).toEqual(['date', 'description', 'account', 'amount', 'status'])
  })
})
