/**
 * The salary payment-file operation (lib/operations/salary-payment-files.ts):
 * an MCP-only read over the archive the v1 route reads, metadata only. The
 * archive service is mocked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { getStructuredError } from '@/lib/errors/get-structured-error'
import type { OperationContext } from '../types'

const mockList = vi.fn()
vi.mock('@/lib/salary/payment/payment-file-archive', () => ({
  listSalaryPaymentFiles: (...a: unknown[]) => mockList(...a),
}))

import { salaryRunsPaymentFilesList } from '../salary-payment-files'

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const RUN_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const FILE_ID = 'f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0'

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

const METADATA = {
  payment_file_id: FILE_ID,
  format: 'bg_lb',
  filename: 'bg_lb_lon_2026-04.txt',
  content_type: 'text/plain',
  charset: 'iso-8859-1',
  sha256: 'b'.repeat(64),
  byte_size: 44,
  payment_date: '2026-04-24',
  employee_count: 2,
  total_amount: 45000,
  generated_at: '2026-04-19T09:00:00.000Z',
}
const ARCHIVED = { ...METADATA, content: '11123456700000000000260325LÖN 2026-04\r\n' }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('salary-runs.payment-files.list (gnubok_list_salary_payment_files)', () => {
  it('is an MCP-only read reusing the v1 id and scope, with qualified ids and no content field', () => {
    const op = salaryRunsPaymentFilesList
    expect(op).toMatchObject({ id: 'salary-runs.payment-files.list', kind: 'read', scope: 'payroll:read', risk: 'low' })
    expect(op.http).toBeUndefined()
    expect(op.mcp?.name).toBe('gnubok_list_salary_payment_files')
    expect(op.mcp?.stage).toBeUndefined()
    expect(op.mcp?.visibility ?? 'search').toBe('search')
    const keys = schemaKeys(z.toJSONSchema(op.output))
    expect(keys).not.toContain('id')
    expect(keys).not.toContain('content')
  })

  it('lists the archived files without their content, ten per page by default', async () => {
    mockList.mockResolvedValue({ ok: true, files: [ARCHIVED], nextCursor: 'next-1' })
    const input = salaryRunsPaymentFilesList.input.parse({ salary_run_id: RUN_ID })

    const outcome = await salaryRunsPaymentFilesList.run(ctx(), input, { dryRun: false })

    expect(mockList).toHaveBeenCalledWith(expect.anything(), {
      companyId: COMPANY_ID,
      salaryRunId: RUN_ID,
      limit: 10,
      cursor: undefined,
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok || outcome.dryRun) return
    expect(outcome.data).toEqual({ salary_run_id: RUN_ID, salary_payment_files: [METADATA], next_cursor: 'next-1' })
    expect(JSON.stringify(outcome.data)).not.toContain('LÖN 2026-04')
    expect(salaryRunsPaymentFilesList.output.parse(outcome.data)).toEqual(outcome.data)
  })

  it('passes the cursor and a coerced limit through', async () => {
    mockList.mockResolvedValue({ ok: true, files: [], nextCursor: null })
    const input = salaryRunsPaymentFilesList.input.parse({ salary_run_id: RUN_ID, limit: '2', cursor: 'abc' })

    await salaryRunsPaymentFilesList.run(ctx(), input, { dryRun: false })

    expect(mockList).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ limit: 2, cursor: 'abc' }))
  })

  it('answers SALARY_RUN_NOT_FOUND for a run outside the company', async () => {
    mockList.mockResolvedValue({ ok: false, code: 'RUN_NOT_FOUND' })

    const outcome = await salaryRunsPaymentFilesList.run(ctx(), { salary_run_id: RUN_ID, limit: 10 }, { dryRun: false })

    expect(outcome).toEqual({ ok: false, code: 'SALARY_RUN_NOT_FOUND' })
  })

  it('hands a database failure over with its SQLSTATE', async () => {
    mockList.mockResolvedValue({ ok: false, code: 'DB_ERROR', cause: { code: '57014', message: 'canceling statement due to statement timeout' } })

    const outcome = await salaryRunsPaymentFilesList.run(ctx(), { salary_run_id: RUN_ID, limit: 10 }, { dryRun: false })

    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(getStructuredError(outcome.error).retryable).toBe(true)
  })
})
