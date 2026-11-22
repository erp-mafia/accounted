import { describe, it, expect } from 'vitest'
import { statusesInForce } from '../snapshot-statuses'

// The status history Lens returned for a sole trader restarted under a
// registration struck off years earlier, shaped as the snapshot stores it.
const restartedSoleTraderStatuses = [
  {
    code: 'taxAuthorityStatus',
    color: 'neutral',
    isCeased: false,
    statusDate: '2024-01-15T00:00:00',
    description: 'Skatteverksstatus',
  },
  {
    code: 'isActive',
    color: 'green',
    isCeased: false,
    statusDate: '2014-02-03T00:00:00',
    description: 'Är verksam',
  },
  {
    code: 'deregistered',
    color: 'red',
    isCeased: true,
    statusDate: '2006-03-10T00:00:00',
    description: 'Avregistrerad p g a verksamheten upphört',
  },
]

describe('statusesInForce', () => {
  it('drops a strike-off the firm has restarted past', () => {
    const shown = statusesInForce({
      activityStatus: 'isActive',
      statuses: restartedSoleTraderStatuses,
    })
    expect(shown.map((s) => s.code)).toEqual(['taxAuthorityStatus', 'isActive'])
    expect(shown.some((s) => s.isCeased)).toBe(false)
  })

  it('keeps the ceased status of a firm that is ceased today', () => {
    const shown = statusesInForce({
      activityStatus: 'ceased',
      statuses: restartedSoleTraderStatuses,
    })
    expect(shown.map((s) => s.code)).toEqual(['taxAuthorityStatus', 'isActive', 'deregistered'])
  })

  it('keeps every dated status when the snapshot has no current state', () => {
    // Older snapshots predate activityStatus: nothing says the strike-off
    // was overtaken, so it stays.
    expect(statusesInForce({ statuses: restartedSoleTraderStatuses })).toHaveLength(3)
    expect(statusesInForce({ activityStatus: null, statuses: restartedSoleTraderStatuses })).toHaveLength(3)
  })

  it('drops undated informational flags', () => {
    const shown = statusesInForce({
      activityStatus: 'isActive',
      statuses: [
        { code: 'neverActive', description: 'Har aldrig varit verksam', statusDate: null },
        { code: 'isActive', description: 'Är verksam', statusDate: '2014-02-03T00:00:00', isCeased: false },
      ],
    })
    expect(shown.map((s) => s.code)).toEqual(['isActive'])
  })

  it('returns nothing for a missing snapshot or a malformed list', () => {
    expect(statusesInForce(null)).toEqual([])
    expect(statusesInForce(undefined)).toEqual([])
    expect(statusesInForce({ statuses: null })).toEqual([])
    expect(
      statusesInForce({ statuses: 'x' as unknown as never[] }),
    ).toEqual([])
    expect(
      statusesInForce({ statuses: [null, { statusDate: '2020-01-01' }] as unknown as { statusDate?: string }[] }),
    ).toHaveLength(1)
  })
})
