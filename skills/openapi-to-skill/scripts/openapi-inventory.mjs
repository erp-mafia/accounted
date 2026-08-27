#!/usr/bin/env node
/**
 * openapi-inventory: turn a large OpenAPI 3.x spec into agent-readable text.
 *
 * Portable by design: no imports outside the Node standard library (YAML
 * specs are handled via js-yaml when it is resolvable from the working
 * directory, with a clear error otherwise). This file is shipped inside the
 * `openapi-to-skill` agent skill and copied into consumer repos, so it must
 * never grow a dependency on the repository that hosts it.
 *
 * CLI:
 *   node openapi-inventory.mjs <spec.json|.yaml>            # compact overview
 *   node openapi-inventory.mjs <spec> --group <name>        # full detail for one group
 *   node openapi-inventory.mjs <spec> --json                # machine-readable inventory
 *
 * Library (used by deterministic skill generators):
 *   loadSpec, listOperations, buildInventory, condenseSchema,
 *   renderOperationMd, formatOpLine
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

// ---------------------------------------------------------------------------
// Spec loading
// ---------------------------------------------------------------------------

export function loadSpec(specPath) {
  const raw = readFileSync(specPath, 'utf8')
  const trimmed = raw.trimStart()
  if (trimmed.startsWith('{')) return JSON.parse(raw)

  // YAML fallback: resolve js-yaml from the consumer's project if present.
  try {
    const require = createRequire(`${process.cwd()}/`)
    const yaml = require('js-yaml')
    return yaml.load(raw)
  } catch {
    throw new Error(
      `${specPath} looks like YAML but js-yaml is not resolvable from ${process.cwd()}. ` +
        `Convert it first (e.g. "npx -y js-yaml ${specPath} > spec.json") and re-run on the JSON file.`,
    )
  }
}

// ---------------------------------------------------------------------------
// $ref resolution
// ---------------------------------------------------------------------------

export function resolveRef(spec, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return undefined
  let node = spec
  for (const part of ref.slice(2).split('/')) {
    node = node?.[part.replace(/~1/g, '/').replace(/~0/g, '~')]
    if (node === undefined) return undefined
  }
  return node
}

function deref(spec, schema, seen) {
  if (schema && typeof schema === 'object' && schema.$ref) {
    if (seen.has(schema.$ref)) return { __cycle: schema.$ref }
    seen.add(schema.$ref)
    const target = resolveRef(spec, schema.$ref)
    return target === undefined ? { __unresolved: schema.$ref } : target
  }
  return schema
}

// ---------------------------------------------------------------------------
// Schema condenser: JSON Schema -> TypeScript-ish compact notation
// ---------------------------------------------------------------------------

const MAX_DEPTH = 6

export function condenseSchema(spec, schema, { depth = 0, seen = new Set() } = {}) {
  if (schema === undefined || schema === null) return 'unknown'
  if (schema === true) return 'unknown'
  if (schema === false) return 'never'

  schema = deref(spec, schema, seen)
  if (schema.__cycle) return refName(schema.__cycle)
  if (schema.__unresolved) return refName(schema.__unresolved)
  if (depth > MAX_DEPTH) return '{...}'

  if (Array.isArray(schema.enum)) {
    return schema.enum.map((v) => JSON.stringify(v)).join(' | ')
  }
  if (schema.const !== undefined) return JSON.stringify(schema.const)

  for (const key of ['oneOf', 'anyOf']) {
    if (Array.isArray(schema[key]) && schema[key].length > 0) {
      const parts = schema[key].map((s) => condenseSchema(spec, s, { depth: depth + 1, seen }))
      return [...new Set(parts)].join(' | ')
    }
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    const merged = {}
    const required = new Set(schema.required ?? [])
    for (const part of schema.allOf) {
      const resolved = deref(spec, part, seen)
      if (resolved && typeof resolved === 'object') {
        Object.assign(merged, resolved.properties)
        for (const r of resolved.required ?? []) required.add(r)
      }
    }
    return condenseSchema(
      spec,
      { type: 'object', properties: merged, required: [...required] },
      { depth, seen },
    )
  }

  let type = schema.type
  if (Array.isArray(type)) {
    const parts = type.map((t) =>
      condenseSchema(spec, { ...schema, type: t }, { depth, seen }),
    )
    return [...new Set(parts)].join(' | ')
  }

  if (type === 'array') {
    const item = condenseSchema(spec, schema.items, { depth: depth + 1, seen })
    return item.includes(' ') && !item.startsWith('{') ? `(${item})[]` : `${item}[]`
  }

  if (type === 'object' || schema.properties) {
    const props = schema.properties ?? {}
    const required = new Set(schema.required ?? [])
    const keys = Object.keys(props)
    if (keys.length === 0) {
      if (schema.additionalProperties) {
        const val = condenseSchema(spec, schema.additionalProperties, { depth: depth + 1, seen })
        return `Record<string, ${val}>`
      }
      return '{}'
    }
    const entries = keys.map((k) => {
      const opt = required.has(k) ? '' : '?'
      const val = condenseSchema(spec, props[k], { depth: depth + 1, seen })
      return `${k}${opt}: ${val}`
    })
    const inline = `{ ${entries.join(', ')} }`
    if (inline.length <= 100 || depth >= 2) return inline
    const pad = '  '.repeat(depth + 1)
    const close = '  '.repeat(depth)
    return `{\n${pad}${entries.join(`,\n${pad}`)}\n${close}}`
  }

  if (type === 'integer') type = 'number'
  if (!type) return 'unknown'
  const fmt = schema.format && schema.format !== 'binary' ? `(${schema.format})` : ''
  return `${type}${fmt}`
}

function refName(ref) {
  const parts = ref.split('/')
  return parts[parts.length - 1] || 'unknown'
}

// ---------------------------------------------------------------------------
// Operation listing and grouping
// ---------------------------------------------------------------------------

const HTTP_METHODS = ['get', 'put', 'post', 'patch', 'delete', 'head', 'options', 'trace']
const SKIP_SEGMENTS = /^(api|v\d+)$/i

function staticSegments(path) {
  return path
    .split('/')
    .filter(Boolean)
    .filter((s) => !s.startsWith('{') && !SKIP_SEGMENTS.test(s))
}

/**
 * List every operation with a derived `group`.
 *
 * Grouping: tags win when present. Otherwise the group is a static path
 * segment, chosen by "dominance descent": start with the first static
 * segment; while a single group holds more than 60% of all operations and
 * its members have deeper static segments to descend into, regroup those
 * members one static segment deeper. This turns
 * `/companies/{companyId}/invoices/...` into group `invoices` instead of
 * lumping the whole API under `companies`.
 */
export function listOperations(spec) {
  const ops = []
  for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const op = pathItem?.[method]
      if (!op) continue
      ops.push({
        path,
        method: method.toUpperCase(),
        op,
        pathItem,
        segments: staticSegments(path),
        depth: 0,
        group: op.tags?.[0] ?? null,
      })
    }
  }

  const untagged = ops.filter((o) => o.group === null)
  for (const o of untagged) o.group = o.segments[0] ?? 'root'

  for (let round = 0; round < 3 && untagged.length > 0; round++) {
    const counts = new Map()
    for (const o of untagged) counts.set(o.group, (counts.get(o.group) ?? 0) + 1)
    const [dominant, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
    if (count / ops.length <= 0.6) break
    let descended = false
    for (const o of untagged) {
      if (o.group !== dominant) continue
      const next = o.segments[o.depth + 1]
      if (next) {
        o.depth += 1
        o.group = next
        descended = true
      }
    }
    if (!descended) break
  }

  return ops
}

export function buildInventory(spec) {
  const ops = listOperations(spec)
  const groups = new Map()
  for (const o of ops) {
    if (!groups.has(o.group)) groups.set(o.group, [])
    groups.get(o.group).push(o)
  }
  return {
    title: spec.info?.title ?? 'Untitled API',
    version: spec.info?.version ?? '',
    description: spec.info?.description ?? '',
    servers: (spec.servers ?? []).map((s) => s.url),
    securitySchemes: spec.components?.securitySchemes ?? {},
    operationCount: ops.length,
    groups: [...groups.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, members]) => ({ name, operations: members })),
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Known agent-oriented x- extensions, rendered as a compact annotation. */
function extensionBadges(op) {
  const badges = []
  if (op['x-required-scope']) badges.push(`scope:${op['x-required-scope']}`)
  if (op['x-action-risk']) badges.push(`risk:${op['x-action-risk']}`)
  if (op['x-idempotent']) badges.push('idempotent')
  if (op['x-dry-run-supported']) badges.push('dry-run')
  if (op['x-reversible']) badges.push('reversible')
  if (op.deprecated) badges.push('DEPRECATED')
  return badges
}

export function formatOpLine(entry) {
  const { method, path, op } = entry
  const badges = extensionBadges(op)
  const summary = (op.summary ?? op.operationId ?? '').replace(/\.$/, '')
  const badgeStr = badges.length > 0 ? ` [${badges.join(' ')}]` : ''
  return `${method} ${path} : ${summary}${badgeStr}`
}

/** Escape a string for use inside a Markdown table cell. */
function mdCell(text) {
  return text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|')
}

function collectParameters(spec, entry) {
  const seen = new Set()
  const params = []
  for (const raw of [...(entry.pathItem.parameters ?? []), ...(entry.op.parameters ?? [])]) {
    const p = raw.$ref ? resolveRef(spec, raw.$ref) : raw
    if (!p) continue
    const key = `${p.in}:${p.name}`
    if (seen.has(key)) continue
    seen.add(key)
    params.push(p)
  }
  return params
}

function successResponse(op) {
  for (const code of ['200', '201', '202', '204']) {
    if (op.responses?.[code]) return [code, op.responses[code]]
  }
  return [null, null]
}

/**
 * A media-type `example` rendered as a fenced JSON block.
 *
 * A condensed schema tells an agent the shape of a field; a worked example
 * tells it the conventions the shape cannot express (id formats, which
 * optional fields normally travel together, plausible values). Both are
 * cheap to read and only one of them is derivable from types.
 */
function renderExample(label, value) {
  if (value === undefined || value === null) return []
  let json
  try {
    json = JSON.stringify(value, null, 2)
  } catch {
    return []
  }
  if (!json) return []
  return [`${label}:`, '```json', json, '```', '']
}

/**
 * Full Markdown block for one operation: what a reference file is built from.
 */
export function renderOperationMd(spec, entry) {
  const { method, path, op } = entry
  const lines = []
  const summary = (op.summary ?? '').replace(/\.$/, '')
  lines.push(`### \`${method} ${path}\``)
  lines.push('')
  if (summary) lines.push(`**${summary}.**`)
  const badges = extensionBadges(op)
  if (badges.length > 0) lines.push(`\`${badges.join(' · ')}\``)
  lines.push('')
  if (op.description) {
    lines.push(op.description.trim())
    lines.push('')
  }

  const params = collectParameters(spec, entry)
  const queryAndPath = params.filter((p) => p.in === 'query' || p.in === 'path' || p.in === 'header')
  if (queryAndPath.length > 0) {
    lines.push('| Parameter | In | Type | Required | Notes |')
    lines.push('|---|---|---|---|---|')
    for (const p of queryAndPath) {
      const type = condenseSchema(spec, p.schema, { depth: 2 })
      const note = (p.description ?? '').replace(/\s+/g, ' ').trim()
      lines.push(
        `| \`${p.name}\` | ${p.in} | \`${mdCell(type)}\` | ${p.required ? 'yes' : 'no'} | ${mdCell(note)} |`,
      )
    }
    lines.push('')
  }

  const jsonBody = op.requestBody?.content?.['application/json']
  const body = jsonBody?.schema
  const multipart = op.requestBody?.content?.['multipart/form-data']?.schema
  if (body) {
    lines.push('Request body:')
    lines.push('```ts')
    lines.push(condenseSchema(spec, body))
    lines.push('```')
    lines.push('')
    lines.push(...renderExample('Example request', jsonBody.example))
  } else if (multipart) {
    lines.push('Request body (`multipart/form-data`):')
    lines.push('```ts')
    lines.push(condenseSchema(spec, multipart))
    lines.push('```')
    lines.push('')
  }

  const [code, response] = successResponse(op)
  const jsonResponse = response?.content?.['application/json']
  const responseSchema = jsonResponse?.schema
  if (responseSchema) {
    lines.push(`Response \`${code}\`:`)
    lines.push('```ts')
    lines.push(condenseSchema(spec, responseSchema))
    lines.push('```')
    lines.push('')
    lines.push(...renderExample(`Example response \`${code}\``, jsonResponse.example))
  } else if (response) {
    const contentTypes = Object.keys(response.content ?? {})
    lines.push(
      `Response \`${code}\`${contentTypes.length > 0 ? ` (\`${contentTypes.join('`, `')}\`)` : ''}.`,
    )
    lines.push('')
  }

  const errorCodes = Object.keys(op.responses ?? {}).filter((c) => /^[45]/.test(c))
  if (errorCodes.length > 0) {
    const described = errorCodes
      .map((c) => {
        const desc = (op.responses[c].description ?? '').replace(/\s+/g, ' ').trim()
        return desc && desc.toLowerCase() !== 'error' ? `\`${c}\` (${desc})` : `\`${c}\``
      })
      .join(', ')
    lines.push(`Errors: ${described}`)
    lines.push('')
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2)
  const specPath = args.find((a) => !a.startsWith('--'))
  if (!specPath) {
    console.error(
      'Usage: openapi-inventory.mjs <spec.json|.yaml> [--group <name>] [--json]',
    )
    process.exit(1)
  }
  const spec = loadSpec(specPath)
  const inv = buildInventory(spec)

  if (args.includes('--json')) {
    const plain = {
      ...inv,
      groups: inv.groups.map((g) => ({
        name: g.name,
        operations: g.operations.map((o) => ({
          method: o.method,
          path: o.path,
          operationId: o.op.operationId,
          summary: o.op.summary,
        })),
      })),
    }
    console.log(JSON.stringify(plain, null, 2))
    return
  }

  const groupArg = args.indexOf('--group')
  if (groupArg !== -1) {
    const name = args[groupArg + 1]
    const group = inv.groups.find((g) => g.name === name)
    if (!group) {
      console.error(
        `No group "${name}". Groups: ${inv.groups.map((g) => g.name).join(', ')}`,
      )
      process.exit(1)
    }
    console.log(`## ${name} (${group.operations.length} operations)\n`)
    for (const entry of group.operations) {
      console.log(renderOperationMd(spec, entry))
      console.log('---\n')
    }
    return
  }

  // Compact overview.
  console.log(`# ${inv.title} ${inv.version}`.trim())
  if (inv.servers.length > 0) console.log(`Servers: ${inv.servers.join(', ')}`)
  const schemes = Object.entries(inv.securitySchemes)
    .map(([n, s]) => `${n} (${[s.type, s.scheme, s.bearerFormat].filter(Boolean).join(' ')})`)
    .join(', ')
  if (schemes) console.log(`Auth: ${schemes}`)
  console.log(`Operations: ${inv.operationCount}\n`)
  if (inv.description) console.log(`${inv.description.trim()}\n`)
  for (const group of inv.groups) {
    console.log(`## ${group.name} (${group.operations.length})`)
    for (const entry of group.operations) console.log(formatOpLine(entry))
    console.log('')
  }
}

const isDirectRun =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href
if (isDirectRun) main()
