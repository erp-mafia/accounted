export type McpToolNamespace = 'gnubok' | 'accounted'

export const TOOL_NAMESPACE_QUERY_PARAM = 'tool_namespace'

const LEGACY_TOOL_PREFIX = 'gnubok_'
const ACCOUNTED_TOOL_PREFIX = 'accounted_'
const LEGACY_TOOL_REFERENCE_RE = /\bgnubok_[A-Za-z0-9_]+\b/g
const ACCOUNTED_TOOL_REFERENCE_RE = /\baccounted_[A-Za-z0-9_]+\b/g

export function resolveMcpToolNamespace(request: Request): McpToolNamespace {
  const requested = new URL(request.url).searchParams.get(TOOL_NAMESPACE_QUERY_PARAM)
  return requested === 'accounted' ? 'accounted' : 'gnubok'
}

export function toCanonicalToolName(name: string): string {
  if (!name.startsWith(ACCOUNTED_TOOL_PREFIX)) return name
  return `${LEGACY_TOOL_PREFIX}${name.slice(ACCOUNTED_TOOL_PREFIX.length)}`
}

export function toPublicToolName(name: string, namespace: McpToolNamespace): string {
  if (namespace !== 'accounted' || !name.startsWith(LEGACY_TOOL_PREFIX)) return name
  return `${ACCOUNTED_TOOL_PREFIX}${name.slice(LEGACY_TOOL_PREFIX.length)}`
}

export function canonicalizeToolReferencesInText(text: string): string {
  return text.replace(ACCOUNTED_TOOL_REFERENCE_RE, (name) => toCanonicalToolName(name))
}

export function projectToolReferencesInText(
  text: string,
  namespace: McpToolNamespace,
  canonicalToolNames: ReadonlySet<string>,
): string {
  if (namespace === 'gnubok') return text
  return text.replace(LEGACY_TOOL_REFERENCE_RE, (name) =>
    canonicalToolNames.has(name) ? toPublicToolName(name, namespace) : name
  )
}

/**
 * Project server-owned MCP payloads into the selected public namespace.
 *
 * Only exact references to registered tool names are rewritten. Wire-format
 * identifiers such as gnubok_sk_ API keys therefore remain unchanged.
 */
export function projectToolReferences<T>(
  value: T,
  namespace: McpToolNamespace,
  canonicalToolNames: ReadonlySet<string>,
): T {
  if (namespace === 'gnubok') return value

  if (typeof value === 'string') {
    return projectToolReferencesInText(value, namespace, canonicalToolNames) as T
  }

  if (Array.isArray(value)) {
    return value.map((item) =>
      projectToolReferences(item, namespace, canonicalToolNames)
    ) as T
  }

  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        projectToolReferences(item, namespace, canonicalToolNames),
      ])
    ) as T
  }

  return value
}
