/**
 * The contract every operation in the registry must meet (see ../types.ts).
 * An operation is defined once, but a few client-imported data tables still
 * have to know about it: the MCP scope catalogue, the risk tiers, the
 * approval vocabulary and its messages, the v1 scope map. This test names
 * exactly what is missing, so adding an operation is a matter of following
 * its failures.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { describe, expect, it } from 'vitest'
import { TOOL_SCOPE_MAP } from '@/lib/auth/scope-catalog'
import { V1_ENDPOINT_SCOPES } from '@/lib/auth/scopes'
import { OPERATION_RISK_TIERS } from '@/lib/pending-operations/risk-tiers'
import { OPERATION_LABEL_KEYS, singleActionWarnings } from '@/components/pending-operations/vocabulary'
import { listEndpoints } from '@/lib/api/v1/registry'
import '@/lib/api/v1/load-routes'
import { OPERATIONS } from '../registry'

const messages = (lang: 'sv' | 'en') =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../messages/${lang}.json`, import.meta.url)), 'utf8')) as {
    pending: Record<string, string>
  }

describe('operation registry contract', () => {
  it('has unique operation ids, tool names and pending types', () => {
    const ids = OPERATIONS.map((op) => op.id)
    expect(new Set(ids).size).toBe(ids.length)
    const tools = OPERATIONS.flatMap((op) => (op.mcp ? [op.mcp.name] : []))
    expect(new Set(tools).size).toBe(tools.length)
    const pending = OPERATIONS.flatMap((op) => (op.mcp?.stage ? [op.mcp.stage.pendingType] : []))
    expect(new Set(pending).size).toBe(pending.length)
  })

  it('names every operation <resource>.<verb>', () => {
    for (const op of OPERATIONS) expect(op.id, op.id).toMatch(/^[a-z][a-z-]*(\.[a-z][a-z-]*)+$/)
  })

  it('takes a JSON object as input', () => {
    for (const op of OPERATIONS) expect(op.input instanceof z.ZodObject, op.id).toBe(true)
  })

  it('maps every path segment to an input field', () => {
    for (const op of OPERATIONS) {
      const shape = (op.input as unknown as z.ZodObject<z.ZodRawShape>).shape
      for (const [segment, field] of Object.entries(op.http?.pathParams ?? {})) {
        expect(op.http!.path, `${op.id}: :${segment}`).toContain(`:${segment}`)
        expect(Object.keys(shape), `${op.id}: ${field}`).toContain(field)
      }
    }
  })

  it('is registered in the v1 spec under its scope', () => {
    const registered = new Map(listEndpoints().map((e) => [e.operation, e]))
    for (const op of OPERATIONS.filter((o) => o.http)) {
      const endpoint = registered.get(op.id)
      expect(endpoint, `${op.id}: route file missing or not imported by load-routes.ts`).toBeDefined()
      expect(endpoint!.path).toBe(op.http!.path)
      expect(V1_ENDPOINT_SCOPES[`${op.http!.method} ${op.http!.path}`], `${op.id}: V1_ENDPOINT_SCOPES`).toBe(op.scope)
    }
  })

  it('gates every MCP tool by the operation scope', () => {
    for (const op of OPERATIONS.filter((o) => o.mcp)) {
      expect(TOOL_SCOPE_MAP[op.mcp!.name], `${op.mcp!.name}: TOOL_SCOPE_MAP`).toBe(op.scope)
    }
  })

  it('stages every MCP write, described as staging, within the description budget', () => {
    for (const op of OPERATIONS.filter((o) => o.mcp && o.kind === 'write')) {
      expect(op.mcp!.stage, `${op.id}: MCP writes always stage`).toBeDefined()
      const description = op.mcp!.description ?? op.docs.summary
      expect(description, op.id).toMatch(/\bstage\b/i)
      expect(description.length, op.id).toBeLessThanOrEqual(280)
    }
  })

  it('declares every pending type in the risk tiers, the vocabulary and both languages', () => {
    const sv = messages('sv').pending
    const en = messages('en').pending
    for (const op of OPERATIONS.filter((o) => o.mcp?.stage)) {
      const type = op.mcp!.stage!.pendingType
      expect(OPERATION_RISK_TIERS[type], `${type}: OPERATION_RISK_TIERS`).toBe(op.risk)
      const labelKey = OPERATION_LABEL_KEYS[type]
      expect(labelKey, `${type}: OPERATION_LABEL_KEYS`).toBeDefined()
      expect(sv[labelKey], `${type}: messages/sv.json pending.${labelKey}`).toBeTruthy()
      expect(en[labelKey], `${type}: messages/en.json pending.${labelKey}`).toBeTruthy()
      if (op.risk !== 'low') {
        expect(singleActionWarnings[type], `${type}: singleActionWarnings (risk ${op.risk})`).toBeTruthy()
      }
    }
  })
})
