import { describe, expect, it } from 'vitest'
import { mcpCommitActorType, mcpToolCallActor } from '../commit-actor'

describe('mcpCommitActorType', () => {
  it('reads the record type off the connection facts, never off the label', () => {
    expect(mcpCommitActorType({ type: 'api_key', label: 'Claude (Anthropic)', oauthKey: true })).toBe('mcp_oauth')
    expect(mcpCommitActorType({ type: 'api_key', label: 'Claude (Anthropic)' })).toBe('api_key')
    expect(mcpCommitActorType({ type: 'api_key', label: 'Synk', serviceAccountId: 'sa-1', oauthKey: true })).toBe('service_account')
    expect(mcpCommitActorType({ type: 'agent_chat', label: 'In-app chat' })).toBe('user')
    expect(mcpCommitActorType(undefined)).toBe('user')
  })
})

describe('mcpToolCallActor', () => {
  it("names the credential and the key's user", () => {
    expect(mcpToolCallActor({ type: 'api_key', label: 'Claude (Anthropic)', oauthKey: true }, 'user-1')).toEqual({
      type: 'mcp_oauth',
      label: 'Claude (Anthropic)',
      userId: 'user-1',
    })
  })

  it('binds no scope for an anonymous caller', () => {
    expect(mcpToolCallActor({ type: 'anonymous', label: 'Not connected' }, '')).toBeNull()
    expect(mcpToolCallActor({ type: 'api_key', label: 'Integration' }, '')).toBeNull()
  })
})
