import { describe, expect, it } from 'vitest'
import { buildSandboxVatDeadline } from '../vat-deadline'

describe('buildSandboxVatDeadline', () => {
  it('uses the August 17 deadline for a Q2 sandbox', () => {
    expect(buildSandboxVatDeadline(new Date(2026, 4, 15))).toEqual({
      title: 'Momsdeklaration Q2 2026',
      dueDate: '2026-08-17',
      period: '2026-Q2',
    })
  })

  it('rolls the Q4 deadline into February of the following year', () => {
    expect(buildSandboxVatDeadline(new Date(2026, 10, 15))).toEqual({
      title: 'Momsdeklaration Q4 2026',
      dueDate: '2027-02-12',
      period: '2026-Q4',
    })
  })
})
