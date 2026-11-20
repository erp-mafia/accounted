import { describe, expect, it } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import { tools } from '../server'
import { workflowSkills } from '../skills'

/**
 * The result of a filing the user approved in Accounted (Att göra), not by
 * the agent: the BankID signing link Skatteverket answered with lives in the
 * operation's result_data, and gnubok_list_pending_operations returns it for
 * a committed row. An agent that listed the default (pending) found nothing
 * and reported the link unreadable. The skills that file name the read.
 */
describe('reading the result of an operation the user approved in Accounted', () => {
  const listTool = tools.find((t) => t.name === 'gnubok_list_pending_operations')!

  it('returns result_data, the signing link included, on a committed filing', async () => {
    const committed = {
      id: 'op-1', company_id: 'c-1', batch_id: null, operation_type: 'submit_vat_declaration', title: 'Momsdeklaration',
      preview_data: {}, status: 'committed', risk_level: 'high', actor_type: 'api_key', actor_id: 'k-1', actor_label: 'Claude',
      user_id: null, agent_reason: null, created_at: '2026-11-01T10:00:00Z', resolved_at: '2026-11-01T10:05:00Z',
      result_data: { status: 'signing_pending', signing_url: 'https://skatteverket.example/sign/abc' }, rejection_category: null,
    }
    const { supabase, findCalls } = createTableMockSupabase({ pending_operations: { data: [committed], count: 1 } })

    const result = (await listTool.execute(
      { status: 'committed', operation_type: 'submit_vat_declaration' }, 'c-1', 'user-1', supabase as never,
    )) as { operations: Array<{ result_data: { signing_url?: string } }> }

    expect(String(findCalls('pending_operations', 'select')[0][0])).toContain('result_data')
    expect(findCalls('pending_operations', 'eq')).toEqual(expect.arrayContaining([['status', 'committed'], ['operation_type', 'submit_vat_declaration']]))
    expect(result.operations[0].result_data.signing_url).toBe('https://skatteverket.example/sign/abc')
  })

  it.each([
    ['quarterly-vat-review', 'submit_vat_declaration'],
    ['payroll-monthly', 'submit_agi'],
  ])('the %s skill names that read for a filing approved in Accounted', (slug, operationType) => {
    const body = workflowSkills.find((s) => s.slug === slug)?.body ?? ''
    expect(body).toContain(`gnubok_list_pending_operations({ status: "committed", operation_type: "${operationType}" })`)
    expect(body).toContain('result_data.signing_url')
  })
})
