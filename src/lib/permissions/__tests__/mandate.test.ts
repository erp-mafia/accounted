import { describe, expect, it } from 'vitest'
import { decide } from '../decide'
import { DOOR_SPECS, type DoorClass } from '../doors'
import { deriveMandate, type MandateKey } from '../mandate'
import { effectivePersonPermissions } from '../presets'

const door = (spec: (typeof DOOR_SPECS)[keyof typeof DOOR_SPECS], stageable = true): DoorClass => ({
  ...spec,
  stageable,
})

describe('deriveMandate', () => {
  const cases: Array<{ name: string; key: MandateKey; levels: Record<string, string>; highRiskToo: Record<string, boolean> }> = [
    {
      name: 'a manual key with a write scope acts by itself, high risk too',
      key: { kind: 'manual', scopes: ['transactions:write'] },
      levels: { 'bookkeeping.write': 'self' },
      highRiskToo: { 'bookkeeping.write': true },
    },
    {
      name: 'a manual key reads at propose and writes at self',
      key: { kind: 'manual', scopes: ['transactions:read', 'invoices:write'] },
      levels: { 'bookkeeping.read': 'propose', invoicing: 'self' },
      highRiskToo: { invoicing: true },
    },
    {
      name: "a service account's key commits directly, like a manual key",
      key: { kind: 'service_account', scopes: ['payroll:write'] },
      levels: { 'payroll.write': 'self' },
      highRiskToo: { 'payroll.write': true },
    },
    {
      name: 'an OAuth key without the approve scope proposes',
      key: { kind: 'oauth', scopes: ['transactions:write', 'reports:read'] },
      levels: { 'bookkeeping.write': 'propose', 'bookkeeping.read': 'propose' },
      highRiskToo: {},
    },
    {
      name: 'an OAuth key holding pending_operations:approve acts by itself, never high risk too',
      key: { kind: 'oauth', scopes: ['transactions:write', 'pending_operations:approve'] },
      levels: { 'bookkeeping.write': 'self' },
      highRiskToo: {},
    },
    {
      name: 'read-only scopes read only: an invoicing read gives both permissions that open it',
      key: { kind: 'manual', scopes: ['customers:read', 'payroll:read'] },
      levels: { 'bookkeeping.read': 'propose', invoicing: 'propose', 'payroll.read': 'propose' },
      highRiskToo: {},
    },
    {
      name: 'the higher level wins when two scopes give one permission',
      key: { kind: 'manual', scopes: ['invoices:read', 'invoices:write'] },
      levels: { 'bookkeeping.read': 'propose', invoicing: 'self' },
      highRiskToo: { invoicing: true },
    },
    {
      name: 'a read-only company gets nothing from write scopes',
      key: { kind: 'manual', scopes: ['transactions:read', 'transactions:write'], companyAccess: 'read' },
      levels: { 'bookkeeping.read': 'propose' },
      highRiskToo: {},
    },
    {
      name: 'never a permission no agent may hold',
      key: { kind: 'manual', scopes: ['companies:write', 'service_accounts:manage'] },
      levels: {},
      highRiskToo: {},
    },
    {
      name: 'the approve scope alone opens nothing, and unknown scopes are ignored',
      key: { kind: 'oauth', scopes: ['pending_operations:approve', 'nonsense:write'] },
      levels: {},
      highRiskToo: {},
    },
  ]

  for (const c of cases) {
    it(c.name, () => {
      const mandate = deriveMandate(c.key)
      expect(mandate.levels).toEqual(c.levels)
      expect(mandate.highRiskToo).toEqual(c.highRiskToo)
    })
  }

  it("keeps today's behaviour through decide(): a manual write key commits, an OAuth key stages", () => {
    const sponsor = effectivePersonPermissions('member')
    const manual = deriveMandate({ kind: 'manual', scopes: ['transactions:write'] })
    const oauth = deriveMandate({ kind: 'oauth', scopes: ['transactions:write'] })
    const book = door(DOOR_SPECS.BOOK)
    expect(decide({ principal: { kind: 'agent', sponsorPermissions: sponsor, ...manual }, door: book, action: 'call' }))
      .toMatchObject({ outcome: 'allow', reason: 'MANDATE_SELF' })
    expect(decide({ principal: { kind: 'agent', sponsorPermissions: sponsor, ...oauth }, door: book, action: 'call' }))
      .toMatchObject({ outcome: 'stage', reason: 'PROPOSE_STAGES' })
    // A read-only key reads, and is refused the write.
    const reader = deriveMandate({ kind: 'manual', scopes: ['transactions:read'] })
    expect(decide({ principal: { kind: 'agent', sponsorPermissions: sponsor, ...reader }, door: door(DOOR_SPECS.READ, false), action: 'call' }))
      .toMatchObject({ outcome: 'allow' })
    expect(decide({ principal: { kind: 'agent', sponsorPermissions: sponsor, ...reader }, door: book, action: 'call' }))
      .toMatchObject({ outcome: 'deny', reason: 'MANDATE_NEVER' })
  })
})
