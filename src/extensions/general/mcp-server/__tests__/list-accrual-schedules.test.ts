/**
 * Pin tests for gnubok_list_accrual_schedules.
 *
 * The scope mapping is load-bearing: tools missing from TOOL_SCOPE_MAP are
 * usable by ANY API key, so the reports:read pin guards against the tool
 * silently becoming scope-less again.
 */
import { describe, it, expect } from 'vitest'
import { tools } from '../server'
import { TOOL_SCOPE_MAP } from '@/lib/auth/api-keys'

describe('gnubok_list_accrual_schedules: registration', () => {
  it('is registered and read-only', () => {
    const tool = tools.find((t) => t.name === 'gnubok_list_accrual_schedules')
    expect(tool).toBeDefined()
    expect(tool?.annotations.readOnlyHint).toBe(true)
    expect(tool?.annotations.destructiveHint).toBe(false)
  })

  it('is mapped to reports:read scope', () => {
    expect(TOOL_SCOPE_MAP.gnubok_list_accrual_schedules).toBe('reports:read')
  })
})
