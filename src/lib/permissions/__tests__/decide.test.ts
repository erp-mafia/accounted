/**
 * decide() as a table: principal x permission x level x effect x risk x
 * action. Every rule of the model has a row.
 */
import { describe, expect, it } from 'vitest'
import type { Permission } from '../catalog'
import { decide, type DecideInput, type MandateLevel, type Principal } from '../decide'
import type { DoorClass, DoorEffect } from '../doors'
import { effectivePersonPermissions } from '../presets'

const door = (permission: Permission, effect: DoorEffect, stageable: boolean, orPermission?: Permission): DoorClass => ({
  permission,
  effect,
  stageable,
  ...(orPermission ? { orPermission } : {}),
})

const person = (role: string): Principal => ({ kind: 'person', permissions: effectivePersonPermissions(role) })

const agent = (
  levels: Partial<Record<Permission, MandateLevel>>,
  options: { sponsor?: string; highRiskToo?: Partial<Record<Permission, boolean>> } = {},
): Principal => ({
  kind: 'agent',
  sponsorPermissions: effectivePersonPermissions(options.sponsor ?? 'owner'),
  levels,
  highRiskToo: options.highRiskToo ?? {},
})

const LEDGER_STAGED = door('bookkeeping.write', 'ledger', true)
const LEDGER_DIRECT = door('bookkeeping.write', 'ledger', false)
const RECORD_STAGED = door('invoicing', 'record', true)
const RECORD_DIRECT = door('invoicing', 'record', false)
const HOUSE = door('bookkeeping.write', 'housekeeping', false)
const READ = door('bookkeeping.read', 'read', false)
const INVOICE_READ = door('bookkeeping.read', 'read', false, 'invoicing')
const SETTINGS = door('settings', 'record', true)
const MEMBERS = door('members', 'record', false)

type Row = [string, DecideInput, string, string]

describe('decide: people', () => {
  const rows: Row[] = [
    ['member writes the books', { principal: person('member'), door: LEDGER_DIRECT, action: 'call' }, 'allow', 'PERSON_HAS_PERMISSION'],
    ['viewer cannot write the books', { principal: person('viewer'), door: LEDGER_DIRECT, action: 'call' }, 'deny', 'PERMISSION_MISSING'],
    ['viewer reads', { principal: person('viewer'), door: READ, action: 'call' }, 'allow', 'PERSON_HAS_PERMISSION'],
    ['member cannot change settings', { principal: person('member'), door: SETTINGS, action: 'call' }, 'deny', 'PERMISSION_MISSING'],
    ['admin changes settings', { principal: person('admin'), door: SETTINGS, action: 'call' }, 'allow', 'PERSON_HAS_PERMISSION'],
    ['invoicer reads invoices through the second permission', { principal: person('invoicer'), door: INVOICE_READ, action: 'call' }, 'allow', 'PERSON_HAS_PERMISSION'],
    ['invoicer cannot read the books', { principal: person('invoicer'), door: READ, action: 'call' }, 'deny', 'PERMISSION_MISSING'],
    ['a person approves high risk in the app', { principal: person('member'), door: LEDGER_STAGED, action: 'approve', risk: 'high' }, 'allow', 'PERSON_HAS_PERMISSION'],
    ['a person approves a web-only type', { principal: person('admin'), door: SETTINGS, action: 'approve', webOnly: true }, 'allow', 'PERSON_HAS_PERMISSION'],
    ['an unknown role holds nothing', { principal: person('superuser'), door: READ, action: 'call' }, 'deny', 'PERMISSION_MISSING'],
  ]
  it.each(rows)('%s', (_name, input, outcome, reason) => {
    expect(decide(input)).toMatchObject({ outcome, reason })
  })

  it('names the permission it decided on', () => {
    expect(decide({ principal: person('invoicer'), door: INVOICE_READ, action: 'call' }).permission).toBe('invoicing')
    expect(decide({ principal: person('viewer'), door: INVOICE_READ, action: 'call' }).permission).toBe('bookkeeping.read')
  })
})

describe('decide: agents, who may hold what', () => {
  const rows: Row[] = [
    ['never holds members, whatever the mandate', { principal: agent({ members: 'self' }), door: MEMBERS, action: 'call' }, 'deny', 'AGENT_NEVER_HOLDS'],
    ['never holds settings, even to propose', { principal: agent({ settings: 'propose' }), door: SETTINGS, action: 'call' }, 'deny', 'AGENT_NEVER_HOLDS'],
    ['never exceeds its sponsor', { principal: agent({ 'bookkeeping.write': 'self' }, { sponsor: 'viewer' }), door: LEDGER_DIRECT, action: 'call' }, 'deny', 'SPONSOR_LACKS_PERMISSION'],
    ['a narrowed sponsor narrows the agent', { principal: { kind: 'agent', sponsorPermissions: effectivePersonPermissions('member', { 'bookkeeping.write': false }), levels: { 'bookkeeping.write': 'self' }, highRiskToo: {} }, door: LEDGER_DIRECT, action: 'call' }, 'deny', 'SPONSOR_LACKS_PERMISSION'],
    ['a missing level is never', { principal: agent({}), door: READ, action: 'call' }, 'deny', 'MANDATE_NEVER'],
    ['level never', { principal: agent({ 'bookkeeping.write': 'never' }), door: LEDGER_STAGED, action: 'call' }, 'deny', 'MANDATE_NEVER'],
  ]
  it.each(rows)('%s', (_name, input, outcome, reason) => {
    expect(decide(input)).toMatchObject({ outcome, reason })
  })
})

describe('decide: agents calling a door', () => {
  const propose = agent({ 'bookkeeping.read': 'propose', 'bookkeeping.write': 'propose', invoicing: 'propose' })
  const self = agent({ 'bookkeeping.read': 'self', 'bookkeeping.write': 'self', invoicing: 'self' })
  const rows: Row[] = [
    ['propose stages a ledger write', { principal: propose, door: LEDGER_STAGED, action: 'call' }, 'stage', 'PROPOSE_STAGES'],
    ['propose is refused a ledger write that cannot stage', { principal: propose, door: LEDGER_DIRECT, action: 'call' }, 'deny', 'STAGE_REQUIRED'],
    ['propose stages a register write', { principal: propose, door: RECORD_STAGED, action: 'call' }, 'stage', 'PROPOSE_STAGES'],
    ['propose is refused a register write that cannot stage', { principal: propose, door: RECORD_DIRECT, action: 'call' }, 'deny', 'STAGE_REQUIRED'],
    ['propose keeps house', { principal: propose, door: HOUSE, action: 'call' }, 'allow', 'HOUSEKEEPING'],
    ['propose reads', { principal: propose, door: READ, action: 'call' }, 'allow', 'READ'],
    ['self writes the books directly', { principal: self, door: LEDGER_DIRECT, action: 'call' }, 'allow', 'MANDATE_SELF'],
    ['self uses a staging door as it is', { principal: self, door: LEDGER_STAGED, action: 'call' }, 'allow', 'MANDATE_SELF'],
    ['self writes a register directly', { principal: self, door: RECORD_DIRECT, action: 'call' }, 'allow', 'MANDATE_SELF'],
  ]
  it.each(rows)('%s', (_name, input, outcome, reason) => {
    expect(decide(input)).toMatchObject({ outcome, reason })
  })

  it('takes the better mandate of a door that two permissions open', () => {
    const principal = agent({ 'bookkeeping.read': 'never', invoicing: 'self' }, { sponsor: 'member' })
    expect(decide({ principal, door: INVOICE_READ, action: 'call' })).toMatchObject({ outcome: 'allow', permission: 'invoicing' })
    const invoicersAgent = agent({ 'bookkeeping.read': 'self', invoicing: 'propose' }, { sponsor: 'invoicer' })
    expect(decide({ principal: invoicersAgent, door: INVOICE_READ, action: 'call' })).toMatchObject({ outcome: 'allow', reason: 'READ', permission: 'invoicing' })
  })
})

describe('decide: agents approving a staged operation', () => {
  const propose = agent({ 'bookkeeping.write': 'propose' })
  const self = agent({ 'bookkeeping.write': 'self' })
  const selfHighToo = agent({ 'bookkeeping.write': 'self' }, { highRiskToo: { 'bookkeeping.write': true } })
  const highTooElsewhere = agent({ 'bookkeeping.write': 'self' }, { highRiskToo: { invoicing: true } })
  const rows: Row[] = [
    ['propose cannot approve its own proposal', { principal: propose, door: LEDGER_STAGED, action: 'approve', risk: 'low', selfApproval: true }, 'deny', 'SELF_APPROVAL'],
    ['propose sends another proposal to a person', { principal: propose, door: LEDGER_STAGED, action: 'approve', risk: 'low' }, 'sign', 'PROPOSE_NEEDS_PERSON'],
    ['self approves low risk', { principal: self, door: LEDGER_STAGED, action: 'approve', risk: 'low', selfApproval: true }, 'allow', 'MANDATE_SELF'],
    ['self approves medium risk', { principal: self, door: LEDGER_STAGED, action: 'approve', risk: 'medium' }, 'allow', 'MANDATE_SELF'],
    ['self needs a person for high risk', { principal: self, door: LEDGER_STAGED, action: 'approve', risk: 'high' }, 'sign', 'HIGH_RISK_NEEDS_PERSON'],
    ['an unknown risk counts as high', { principal: self, door: LEDGER_STAGED, action: 'approve' }, 'sign', 'HIGH_RISK_NEEDS_PERSON'],
    ['high risk too lets self approve high risk', { principal: selfHighToo, door: LEDGER_STAGED, action: 'approve', risk: 'high' }, 'allow', 'HIGH_RISK_TOO'],
    ['high risk too is per permission', { principal: highTooElsewhere, door: LEDGER_STAGED, action: 'approve', risk: 'high' }, 'sign', 'HIGH_RISK_NEEDS_PERSON'],
    ['a web-only type always needs a person', { principal: selfHighToo, door: LEDGER_STAGED, action: 'approve', risk: 'low', webOnly: true }, 'sign', 'WEB_ONLY'],
    ['a web-only type of a permission the agent never holds is refused', { principal: agent({ settings: 'self' }), door: SETTINGS, action: 'approve', webOnly: true }, 'deny', 'AGENT_NEVER_HOLDS'],
    ['never refuses before anything else', { principal: agent({ 'bookkeeping.write': 'never' }), door: LEDGER_STAGED, action: 'approve', webOnly: true }, 'deny', 'MANDATE_NEVER'],
  ]
  it.each(rows)('%s', (_name, input, outcome, reason) => {
    expect(decide(input)).toMatchObject({ outcome, reason })
  })
})
