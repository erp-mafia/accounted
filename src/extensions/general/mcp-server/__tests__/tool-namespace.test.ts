import { describe, expect, it } from 'vitest'
import {
  canonicalizeToolReferencesInText,
  projectToolReferences,
  resolveMcpToolNamespace,
  toCanonicalToolName,
  toPublicToolName,
} from '../tool-namespace'

const registered = new Set([
  'gnubok_search_tools',
  'gnubok_list_companies',
  'gnubok_approve_pending_operation',
])

describe('MCP tool namespaces', () => {
  it('keeps the legacy namespace unless Accounted is explicitly requested', () => {
    expect(resolveMcpToolNamespace(new Request('https://example.test/mcp'))).toBe('gnubok')
    expect(
      resolveMcpToolNamespace(
        new Request('https://example.test/mcp?tool_namespace=unknown')
      )
    ).toBe('gnubok')
    expect(
      resolveMcpToolNamespace(
        new Request('https://example.test/mcp?tool_namespace=accounted')
      )
    ).toBe('accounted')
  })

  it('maps Accounted aliases to canonical tool names', () => {
    expect(toCanonicalToolName('accounted_list_companies')).toBe(
      'gnubok_list_companies'
    )
    expect(toCanonicalToolName('gnubok_list_companies')).toBe(
      'gnubok_list_companies'
    )
    expect(toPublicToolName('gnubok_list_companies', 'accounted')).toBe(
      'accounted_list_companies'
    )
    expect(toPublicToolName('gnubok_list_companies', 'gnubok')).toBe(
      'gnubok_list_companies'
    )
  })

  it('canonicalizes Accounted references in search queries', () => {
    expect(
      canonicalizeToolReferencesInText(
        'Find accounted_list_companies and accounted_search_tools'
      )
    ).toBe('Find gnubok_list_companies and gnubok_search_tools')
  })

  it('projects only registered tool references and preserves wire identifiers', () => {
    const result = projectToolReferences(
      {
        message:
          'Call gnubok_list_companies, then gnubok_approve_pending_operation.',
        key: 'gnubok_sk_test_example',
        unknown: 'gnubok_not_a_registered_tool',
        next: { tool: 'gnubok_search_tools' },
      },
      'accounted',
      registered
    )

    expect(result).toEqual({
      message:
        'Call accounted_list_companies, then accounted_approve_pending_operation.',
      key: 'gnubok_sk_test_example',
      unknown: 'gnubok_not_a_registered_tool',
      next: { tool: 'accounted_search_tools' },
    })
  })
})
