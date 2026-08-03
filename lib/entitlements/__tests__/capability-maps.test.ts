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
 * external-service tool silently bypassing the paywall: mirrors the
 * TOOL_SCOPE_MAP assertions in the mcp-server tests.
 */
/**
 * MCP tools that invoke a paid capability directly (no stage→commit round-trip),
 * so they are gated at DISPATCH only and have no commit-time (operation-map)
 * counterpart. The document upload tools run Bedrock OCR inline via
 * extractInvoiceFields: they never stage a pending_operation.
 */
const DISPATCH_ONLY_MCP_TOOLS = new Set<string>([
  'gnubok_upload_document',
  'gnubok_create_document_upload',
  'gnubok_complete_document_upload',
])

describe('MCP_TOOL_CAPABILITY_MAP', () => {
  it('gates exactly the paid MCP tools (3 external-service staging tools + the AI OCR tools)', () => {
    expect(MCP_TOOL_CAPABILITY_MAP).toEqual({
      gnubok_send_invoice: CAPABILITY.email_send,
      gnubok_vat_declaration_submit: CAPABILITY.skatteverket,
      gnubok_agi_submit: CAPABILITY.skatteverket,
      // Dispatch-only AI tools: inline Bedrock OCR, no staged operation. The
      // signed-URL pair is gated at create AND complete so a free-tier key can
      // neither reserve nor finalize a paid extraction.
      gnubok_upload_document: CAPABILITY.ai,
      gnubok_create_document_upload: CAPABILITY.ai,
      gnubok_complete_document_upload: CAPABILITY.ai,
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

  it('covers the same capabilities as the STAGING MCP tools (dispatch ↔ commit parity)', () => {
    // Parity applies to staging tools only: an op that can be staged via MCP OR
    // approved in the UI must be gated on both transports. Dispatch-only tools
    // (inline AI OCR) have no commit counterpart and are excluded.
    const stagingMcpCaps = new Set(
      Object.entries(MCP_TOOL_CAPABILITY_MAP)
        .filter(([tool]) => !DISPATCH_ONLY_MCP_TOOLS.has(tool))
        .map(([, cap]) => cap),
    )
    expect(new Set(Object.values(PAID_OPERATION_CAPABILITY_MAP))).toEqual(stagingMcpCaps)
  })
})
