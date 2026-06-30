import { describe, it, expect } from 'vitest'
import {
  MCP_TOOL_CAPABILITY_MAP,
  PAID_OPERATION_CAPABILITY_MAP,
  PAID_CAPABILITIES,
  CAPABILITY,
} from '../keys'

/**
 * These maps are the contract that gates the paid MCP/agent path (dispatch +
 * commit). Locking the exact entries is the guard against a future paid
 * external-service tool silently bypassing the paywall — mirrors the
 * TOOL_SCOPE_MAP assertions in the mcp-server tests.
 */
describe('MCP_TOOL_CAPABILITY_MAP', () => {
  it('gates exactly the three paid external-service MCP tools', () => {
    expect(MCP_TOOL_CAPABILITY_MAP).toEqual({
      gnubok_send_invoice: CAPABILITY.email_send,
      gnubok_vat_declaration_submit: CAPABILITY.skatteverket,
      gnubok_agi_submit: CAPABILITY.skatteverket,
    })
  })

  it('only maps tools to PAID capabilities', () => {
    for (const key of Object.values(MCP_TOOL_CAPABILITY_MAP)) {
      expect(PAID_CAPABILITIES).toContain(key)
    }
  })
})

describe('PAID_OPERATION_CAPABILITY_MAP', () => {
  it('gates exactly the three paid pending-operation types', () => {
    expect(PAID_OPERATION_CAPABILITY_MAP).toEqual({
      send_invoice: CAPABILITY.email_send,
      submit_vat_declaration: CAPABILITY.skatteverket,
      submit_agi: CAPABILITY.skatteverket,
    })
  })

  it('only maps operations to PAID capabilities', () => {
    for (const key of Object.values(PAID_OPERATION_CAPABILITY_MAP)) {
      expect(PAID_CAPABILITIES).toContain(key)
    }
  })

  it('covers the same set of capabilities as the MCP tool map (dispatch ↔ commit parity)', () => {
    expect(new Set(Object.values(PAID_OPERATION_CAPABILITY_MAP))).toEqual(
      new Set(Object.values(MCP_TOOL_CAPABILITY_MAP)),
    )
  })
})
