import { describe, it, expect } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  issuePayslipSections,
  payslipSectionSnapshotRow,
  isPayslipIssuableStatus,
} from '../section-snapshot'

const SHOWN = { salary_payslip_show_employer_cost: true, salary_payslip_show_breakdown: true }
const HIDDEN = { salary_payslip_show_employer_cost: false, salary_payslip_show_breakdown: false }
const ISSUED_SHOWN = {
  payslip_sections_issued_at: '2026-06-24T08:00:00.000Z',
  payslip_show_employer_cost: true,
  payslip_show_breakdown: true,
}
const NOT_ISSUED = {
  payslip_sections_issued_at: null,
  payslip_show_employer_cost: null,
  payslip_show_breakdown: null,
}

describe('payslipSectionSnapshotRow', () => {
  it('stores the effective sections: the breakdown goes with the employer cost', () => {
    expect(
      payslipSectionSnapshotRow(
        { salary_payslip_show_employer_cost: false, salary_payslip_show_breakdown: true },
        '2026-06-24T08:00:00.000Z',
      ),
    ).toEqual({
      payslip_sections_issued_at: '2026-06-24T08:00:00.000Z',
      payslip_show_employer_cost: false,
      payslip_show_breakdown: false,
    })
  })

  it('stores both sections shown for a company without a settings row', () => {
    expect(payslipSectionSnapshotRow(null, '2026-06-24T08:00:00.000Z')).toMatchObject({
      payslip_show_employer_cost: true,
      payslip_show_breakdown: true,
    })
  })
})

describe('isPayslipIssuableStatus', () => {
  it('issues only runs whose payslips are final', () => {
    expect(['approved', 'paid', 'booked'].every(isPayslipIssuableStatus)).toBe(true)
    expect(['draft', 'review', 'corrected'].some(isPayslipIssuableStatus)).toBe(false)
  })
})

describe('issuePayslipSections', () => {
  const companyId = 'company-1'

  it('writes the current switches on the first issue of an approved run, only where no snapshot exists', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    const stored = {
      payslip_sections_issued_at: '2026-06-24T08:00:00.000Z',
      payslip_show_employer_cost: false,
      payslip_show_breakdown: false,
    }
    enqueue({ data: stored })

    const outcome = await issuePayslipSections(supabase as never, {
      companyId,
      run: { id: 'run-1', status: 'approved', ...NOT_ISSUED },
      settings: HIDDEN,
    })

    expect(outcome).toEqual({ ok: true, snapshot: stored })
    const [row] = findCall('salary_runs', 'update') as [Record<string, unknown>]
    expect(row).toMatchObject({ payslip_show_employer_cost: false, payslip_show_breakdown: false })
    expect(findCall('salary_runs', 'is')).toEqual(['payslip_sections_issued_at', null])
  })

  it('never overwrites the snapshot of a run already issued: a later issue returns it untouched', async () => {
    const { supabase, calls } = createQueuedMockSupabase()

    const outcome = await issuePayslipSections(supabase as never, {
      companyId,
      run: { id: 'run-1', status: 'booked', ...ISSUED_SHOWN },
      settings: HIDDEN,
    })

    expect(outcome).toEqual({ ok: true, snapshot: ISSUED_SHOWN })
    expect(calls).toHaveLength(0)
  })

  it('returns what the winning issue stored when a concurrent issue got there first', async () => {
    const { supabase, enqueueMany, findCalls } = createQueuedMockSupabase()
    enqueueMany([
      // The guarded update matched nothing: the snapshot already exists.
      { data: null },
      { data: ISSUED_SHOWN },
    ])

    const outcome = await issuePayslipSections(supabase as never, {
      companyId,
      run: { id: 'run-1', status: 'paid', ...NOT_ISSUED },
      settings: HIDDEN,
    })

    expect(outcome).toEqual({ ok: true, snapshot: ISSUED_SHOWN })
    expect(findCalls('salary_runs', 'update')).toHaveLength(1)
  })

  it('fixes nothing on a run that is still being calculated: its copy follows the live switches', async () => {
    const { supabase, calls } = createQueuedMockSupabase()

    for (const status of ['draft', 'review']) {
      const outcome = await issuePayslipSections(supabase as never, {
        companyId,
        run: { id: 'run-1', status, ...NOT_ISSUED },
        settings: SHOWN,
      })
      expect(outcome).toEqual({ ok: true, snapshot: NOT_ISSUED })
    }
    expect(calls).toHaveLength(0)
  })

  it('fails closed when the write or the re-read fails', async () => {
    const write = createQueuedMockSupabase()
    write.enqueue({ error: { message: 'timeout' } })
    const failedWrite = await issuePayslipSections(write.supabase as never, {
      companyId,
      run: { id: 'run-1', status: 'approved', ...NOT_ISSUED },
      settings: SHOWN,
    })
    expect(failedWrite.ok).toBe(false)

    const reread = createQueuedMockSupabase()
    reread.enqueueMany([{ data: null }, { data: null }])
    const missing = await issuePayslipSections(reread.supabase as never, {
      companyId,
      run: { id: 'run-1', status: 'approved', ...NOT_ISSUED },
      settings: SHOWN,
    })
    expect(missing.ok).toBe(false)
  })
})
