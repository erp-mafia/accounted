import { describe, it, expect } from 'vitest'
import { tools, isStagingTool } from '../server'

// The one closed output object allowed: the staged envelope's next hint, the
// same object in every staging tool. DECISIONS.md 2026-09-01 kept it closed and
// staging.test.ts pins it; its keys are fixed by the NextActionHint type.
const STAGED_NEXT = (tools.find(isStagingTool)!.outputSchema as { properties: { next: unknown } }).properties.next

// Keywords whose value is a subschema (or a list of them), and those whose value
// maps names to subschemas. Everything else (enum, const, examples) is data.
const SUBSCHEMA_KEYWORDS = ['items', 'prefixItems', 'additionalItems', 'contains', 'additionalProperties', 'propertyNames', 'not', 'if', 'then', 'else', 'oneOf', 'anyOf', 'allOf']
const SUBSCHEMA_MAP_KEYWORDS = ['properties', 'patternProperties', 'dependentSchemas', '$defs', 'definitions']

/** Path of every object schema below `schema` that refuses undeclared keys. */
function closedObjectPaths(schema: unknown, path: string): string[] {
  if (Array.isArray(schema)) return schema.flatMap((child, i) => closedObjectPaths(child, `${path}[${i}]`))
  if (typeof schema !== 'object' || schema === null || schema === STAGED_NEXT) return []
  const node = schema as Record<string, unknown>
  const found = node.additionalProperties === false || node.unevaluatedProperties === false ? [path] : []
  for (const key of SUBSCHEMA_KEYWORDS) {
    if (key in node) found.push(...closedObjectPaths(node[key], `${path}.${key}`))
  }
  for (const key of SUBSCHEMA_MAP_KEYWORDS) {
    const map = node[key]
    if (typeof map !== 'object' || map === null) continue
    for (const [name, child] of Object.entries(map)) found.push(...closedObjectPaths(child, `${path}.${key}.${name}`))
  }
  return found
}

describe('outputSchema coverage', () => {
  it('every tool declares an outputSchema', () => {
    const missing = tools.filter((t) => !t.outputSchema).map((t) => t.name)
    expect(missing).toEqual([])
  })

  it('every outputSchema is an object schema', () => {
    for (const t of tools) {
      expect(t.outputSchema, `tool ${t.name} outputSchema`).toBeDefined()
      const schema = t.outputSchema as Record<string, unknown>
      expect(schema.type, `tool ${t.name} outputSchema.type`).toBe('object')
    }
  })

  it('no outputSchema closes an object at any depth: clients cache tools/list and validate against it', () => {
    // 2026-09-21: a field added to gnubok_ask_document under additionalProperties: false made every
    // session connected before the deploy refuse the response. Inputs stay closed (strict-schemas.test.ts).
    // 2026-09-29 (feedback seq 788784): the same break one level down, where the top-level check could
    // not see it: assetView() gained three fields under a closed item and strict clients refused every
    // gnubok_list_assets call. The refusal happens in the client, so our telemetry saw successes.
    expect(tools.flatMap((t) => closedObjectPaths(t.outputSchema, t.name))).toEqual([])
  })

  it('every tool has a tight description (<= 280 chars)', () => {
    const tooLong = tools.filter((t) => t.description.length > 280)
    expect(tooLong.map((t) => `${t.name}: ${t.description.length} chars`)).toEqual([])
  })

  it('no description embeds Args:/Returns:/Examples: blocks (those belong to JSON Schema)', () => {
    const verbose = tools.filter((t) =>
      /Args:\s*\n|Returns JSON:|Examples:\s*\n|Errors:\s*\n/.test(t.description)
    )
    expect(verbose.map((t) => t.name)).toEqual([])
  })
})

describe('annotation correctness', () => {
  it('gnubok_feedback is not read-only (it writes a telemetry event + mutates the rate-limit map)', () => {
    const feedback = tools.find((t) => t.name === 'gnubok_feedback')
    expect(feedback).toBeDefined()
    expect(feedback?.annotations?.readOnlyHint).toBe(false)
  })
})

describe('nullable output properties stay declared nullable', () => {
  // 2026-08-24 audit (sibling of the matched_supplier_id fix, PR #1842):
  // these properties are emitted with null on real code paths (explicit
  // `?? null`, or verbatim passthrough of a nullable column). A bare
  // { type: 'string' } makes strict clients fail SUCCESSFUL calls, and the
  // repeated "failures" trip the caller's circuit breaker. This test pins
  // the declarations so a schema edit cannot silently regress them.
  const NULLABLE: Array<[tool: string, prop: string]> = [
    ['gnubok_get_payslip', 'calculation_breakdown'],
    ['gnubok_get_document_content', 'mime_type'],
    ['gnubok_get_document_content', 'size_bytes'],
    ['gnubok_export_sie', 'company_name'],
    ['gnubok_export_sie', 'org_number'],
    ['gnubok_complete_document_upload', 'matched_supplier_id'],
    ['gnubok_upload_document', 'matched_supplier_id'],
  ]

  it.each(NULLABLE)('%s.%s allows null and is not required', (toolName, prop) => {
    const tool = tools.find((t) => t.name === toolName)
    expect(tool, toolName).toBeDefined()
    const schema = tool!.outputSchema as {
      properties: Record<string, { type: unknown }>
      required?: string[]
    }
    const declared = schema.properties[prop]
    expect(declared, `${toolName}.${prop} must be declared (additionalProperties is false)`).toBeDefined()
    expect(declared.type, `${toolName}.${prop}`).toContain('null')
    expect(schema.required ?? []).not.toContain(prop)
  })

  it('gnubok_export_sie declares every key its execute returns', () => {
    // The tool returned an undeclared org_number under
    // additionalProperties: false, failing strict validation on EVERY call.
    const tool = tools.find((t) => t.name === 'gnubok_export_sie')!
    const props = Object.keys((tool.outputSchema as { properties: Record<string, unknown> }).properties)
    for (const key of ['content', 'byte_size', 'fiscal_period_id', 'company_name', 'org_number', 'generated_at']) {
      expect(props, key).toContain(key)
    }
  })
})
