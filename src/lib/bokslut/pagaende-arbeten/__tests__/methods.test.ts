import { describe, expect, it } from 'vitest'
import type { AuditLogEntry } from '@/types'
import svMessages from '@/messages/sv.json'
import enMessages from '@/messages/en.json'
import { auditRowToEvent } from '@/lib/reports/behandlingshistorik'
import type { ContractRevenueMethod } from '../calculator'
import { CONTRACT_REVENUE_METHOD_NAMES, contractRevenueMethodInText } from '../methods'

describe('the names of the pågående arbeten methods', () => {
  it('are the names K3 kapitel 23 uses, never K2 huvudregeln or alternativregeln', () => {
    expect(CONTRACT_REVENUE_METHOD_NAMES).toEqual({
      successiv: 'Successiv vinstavräkning',
      fardigstallande: 'Färdigställandemetoden',
    })
    expect(contractRevenueMethodInText('successiv')).toBe('successiv vinstavräkning')
    expect(contractRevenueMethodInText('fardigstallande')).toBe('färdigställandemetoden')
  })

  it('are what the register page shows in Swedish, and the English page names both', () => {
    expect(svMessages.contract_revenue.method_successiv).toBe(CONTRACT_REVENUE_METHOD_NAMES.successiv)
    expect(svMessages.contract_revenue.method_fardigstallande).toBe(CONTRACT_REVENUE_METHOD_NAMES.fardigstallande)
    expect(enMessages.contract_revenue.method_successiv).toBe('Percentage of completion')
    expect(enMessages.contract_revenue.method_fardigstallande).toBe('Completed contract')
  })

  // The behandlingshistorik is in the ledger kernel, which may not import the
  // year-end block (lib/modules boundary), so it keeps its own copy: held here.
  it('are what the behandlingshistorik states for a chosen method', () => {
    for (const method of Object.keys(CONTRACT_REVENUE_METHOD_NAMES) as ContractRevenueMethod[]) {
      const row: AuditLogEntry = {
        id: `audit-${method}`,
        user_id: 'user-1',
        company_id: 'company-1',
        action: 'INSERT',
        table_name: 'contract_revenue_settings',
        record_id: 'crs-1',
        actor_id: 'user-1',
        actor_type: 'user',
        actor_label: null,
        old_state: null,
        new_state: { id: 'crs-1', company_id: 'company-1', method, revenue_account: '3095' },
        description: null,
        created_at: '2026-03-10T10:00:00.000Z',
      }
      expect(auditRowToEvent(row)?.details).toContain(`Metod: ${CONTRACT_REVENUE_METHOD_NAMES[method]}`)
    }
  })
})
