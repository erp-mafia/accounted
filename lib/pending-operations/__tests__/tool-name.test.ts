import { describe, it, expect } from 'vitest'
import {
  operationTypeFromToolName,
  toolNameForOperationType,
} from '../tool-name'

/**
 * pending_operations.operation_type is the bare action name; the MCP layer
 * and the live chat stream carry 'gnubok_'-prefixed tool names. Getting the
 * mapping wrong is invisible in mocks but silently drops every hydrated
 * approval card to the generic raw preview (the toolNameFor gotcha this
 * module replaces), so the round-trip is pinned here.
 */

describe('operationTypeFromToolName', () => {
  it('strips the gnubok_ prefix from an MCP tool name', () => {
    expect(operationTypeFromToolName('gnubok_categorize_transaction')).toBe(
      'categorize_transaction',
    )
    expect(operationTypeFromToolName('gnubok_attach_document_to_transaction')).toBe(
      'attach_document_to_transaction',
    )
  })

  it('passes an already-bare operation_type through unchanged', () => {
    expect(operationTypeFromToolName('categorize_transaction')).toBe(
      'categorize_transaction',
    )
  })

  it('passes a non-gnubok tool name through unchanged', () => {
    expect(operationTypeFromToolName('some_vendor_tool')).toBe('some_vendor_tool')
    expect(operationTypeFromToolName('remember_fact')).toBe('remember_fact')
  })
})

describe('toolNameForOperationType', () => {
  it('prefixes a bare operation_type', () => {
    expect(toolNameForOperationType('create_voucher')).toBe('gnubok_create_voucher')
  })

  it('never double-prefixes an already-prefixed name', () => {
    expect(toolNameForOperationType('gnubok_create_voucher')).toBe(
      'gnubok_create_voucher',
    )
  })
})

describe('round-trip', () => {
  // Every operation type with a specialized preview renderer must survive
  // the trip in both directions: this is exactly the path a hydrated
  // approval card's preview dispatch takes.
  const opTypes = [
    'categorize_transaction',
    'create_customer',
    'create_invoice',
    'create_transaction',
    'create_voucher',
    'correct_entry',
    'attach_document_to_transaction',
    'match_transaction_invoice',
  ]

  it.each(opTypes)('%s -> tool name -> back', (opType) => {
    expect(operationTypeFromToolName(toolNameForOperationType(opType))).toBe(opType)
  })
})
