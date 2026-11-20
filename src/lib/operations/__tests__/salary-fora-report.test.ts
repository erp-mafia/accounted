/**
 * The Fora report operation (lib/operations/salary-fora-report.ts): v1 and a
 * search-only MCP read over the same service as the dashboard download, the
 * summary only. The service is mocked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { OperationContext } from '../types'

const mockGenerate = vi.fn()
vi.mock('@/lib/salary/fora/monthly-report', () => ({
  generateForaMonthlyReport: (...a: unknown[]) => mockGenerate(...a),
}))

import { salaryForaReportGet } from '../salary-fora-report'
import { OPERATIONS } from '../registry'

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const EMPLOYEE_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const RUN_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

function ctx(): OperationContext {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() }
  log.child.mockReturnValue(log)
  return { supabase: {} as never, companyId: COMPANY_ID, userId: 'user-1', log: log as never }
}

/** Every key of every object in a JSON schema. */
function schemaKeys(node: unknown, keys: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((n) => schemaKeys(n, keys))
  else if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>
    if (obj.properties && typeof obj.properties === 'object') keys.push(...Object.keys(obj.properties))
    Object.values(obj).forEach((v) => schemaKeys(v, keys))
  }
  return keys
}

const REPORT = {
  year: 2026,
  month: 10,
  filename: 'Fora_5565601712_202610.json',
  file: { source: 'Accounted', reports: [{ refId: '202610', organizationNumber: '5565601712', employments: [], payrolls: [{ employeeId: '195408012230' }] }] },
  payrolls: [
    { employee_id: EMPLOYEE_ID, employee_name: 'Kalle Hall', personnummer_masked: '19540801-XXXX', fok_id: 'FOK306834', pay_amount: 31250, employment_end: null },
  ],
  total_pay_amount: 31250,
  salary_run_ids: [RUN_ID],
  warnings: [],
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('salary-runs.fora-report.get (gnubok_get_fora_report)', () => {
  it('is a registered low-risk payroll read on v1 and search-only MCP, with qualified ids and no file', () => {
    const op = salaryForaReportGet
    expect(OPERATIONS).toContain(op)
    expect(op).toMatchObject({ id: 'salary-runs.fora-report.get', kind: 'read', scope: 'payroll:read', risk: 'low' })
    expect(op.http).toEqual({ method: 'GET', path: '/api/v1/companies/:companyId/salary/fora-report' })
    expect(op.mcp?.name).toBe('gnubok_get_fora_report')
    expect(op.mcp?.stage).toBeUndefined()
    expect(op.mcp?.visibility).toBe('search')
    const keys = schemaKeys(z.toJSONSchema(op.output))
    expect(keys).not.toContain('id')
    expect(keys).not.toContain('file')
    expect(keys).not.toContain('personnummer')
  })

  it('answers the summary and drops the file with its full personnummer', async () => {
    mockGenerate.mockResolvedValue({ ok: true, data: REPORT })
    const input = salaryForaReportGet.input.parse({ year: '2026', month: '10' })

    const outcome = await salaryForaReportGet.run(ctx(), input, { dryRun: false })

    expect(mockGenerate).toHaveBeenCalledWith(expect.anything(), { companyId: COMPANY_ID, year: 2026, month: 10 })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok || outcome.dryRun) return
    expect(salaryForaReportGet.output.parse(outcome.data)).toEqual(outcome.data)
    expect(outcome.data).toMatchObject({ employee_count: 1, total_pay_amount: 31250 })
    expect(JSON.stringify(outcome.data)).not.toContain('195408012230')
  })

  it('refuses a month outside 1-12', () => {
    expect(salaryForaReportGet.input.safeParse({ year: 2026, month: 13 }).success).toBe(false)
  })

  it('answers FORA_REPORT_INCOMPLETE with the issues, and maps the rest', async () => {
    const issues = [{ code: 'FORA_ORG_NUMBER_MISSING', message: 'Företaget saknar organisationsnummer.' }]
    mockGenerate.mockResolvedValue({ ok: false, code: 'FORA_REPORT_INCOMPLETE', issues })
    expect(await salaryForaReportGet.run(ctx(), { year: 2026, month: 10 }, { dryRun: false })).toEqual({
      ok: false,
      code: 'FORA_REPORT_INCOMPLETE',
      details: { issues },
    })

    mockGenerate.mockResolvedValue({ ok: false, code: 'COMPANY_NOT_FOUND' })
    expect(await salaryForaReportGet.run(ctx(), { year: 2026, month: 10 }, { dryRun: false })).toEqual({
      ok: false,
      code: 'COMPANY_NOT_FOUND',
    })

    mockGenerate.mockResolvedValue({ ok: false, code: 'DB_ERROR', cause: { message: 'boom' } })
    expect(await salaryForaReportGet.run(ctx(), { year: 2026, month: 10 }, { dryRun: false })).toMatchObject({
      ok: false,
      code: 'INTERNAL_ERROR',
    })
  })
})
