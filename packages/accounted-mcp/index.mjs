#!/usr/bin/env node
/**
 * accounted-mcp: Connect an MCP client to your Accounted bookkeeping account.
 *
 * Usage in claude_desktop_config.json:
 * {
 *   "mcpServers": {
 *     "accounted": {
 *       "command": "npx",
 *       "args": ["-y", "accounted-mcp"],
 *       "env": {
 *         "ACCOUNTED_API_KEY": "gnubok_sk_..."
 *       }
 *     }
 *   }
 * }
 */

const API_KEY = process.env.ACCOUNTED_API_KEY
const DEFAULT_MCP_URL =
  'https://app.accounted.se/api/extensions/ext/mcp-server/mcp'

function resolveMcpUrl(rawUrl) {
  try {
    const url = new URL(rawUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('unsupported protocol')
    }
    if (!url.searchParams.has('tool_namespace')) {
      url.searchParams.set('tool_namespace', 'accounted')
    }
    return url.toString()
  } catch {
    process.stderr.write('accounted-mcp: ACCOUNTED_URL must be a valid HTTP(S) URL\n')
    process.exit(1)
  }
}

const MCP_URL = resolveMcpUrl(process.env.ACCOUNTED_URL || DEFAULT_MCP_URL)

// Optional distribution-channel marker (for example, "claude-desktop").
// Forwarded for telemetry only and never used for authentication or behavior.
const rawClient = process.env.ACCOUNTED_CLIENT
const CLIENT =
  rawClient && /^[A-Za-z0-9._-]{1,64}$/.test(rawClient) ? rawClient : undefined
if (rawClient && !CLIENT) {
  process.stderr.write(
    'accounted-mcp: ignoring ACCOUNTED_CLIENT: must match [A-Za-z0-9._-]{1,64}\n'
  )
}

if (!API_KEY) {
  process.stderr.write(
    'Error: ACCOUNTED_API_KEY is required.\n' +
      'Get your API key at: https://app.accounted.se/settings?tab=api\n' +
      '\n' +
      'No API key (or no account yet)? Connect over OAuth instead; the sign-in\n' +
      'screen lets you create the account, and setup continues in the chat:\n' +
      '  claude mcp add --transport http accounted \\\n' +
      '    "https://app.accounted.se/api/extensions/ext/mcp-server/mcp?tool_namespace=accounted"\n' +
      '  codex mcp add accounted --url \\\n' +
      '    "https://app.accounted.se/api/extensions/ext/mcp-server/mcp?tool_namespace=accounted"\n' +
      '  Claude.ai / Desktop: Settings > Connectors > Add custom connector with that URL.\n' +
      '\n' +
      'Add it to your Claude Desktop config:\n' +
      '{\n' +
      '  "mcpServers": {\n' +
      '    "accounted": {\n' +
      '      "command": "npx",\n' +
      '      "args": ["-y", "accounted-mcp"],\n' +
      '      "env": {\n' +
      '        "ACCOUNTED_API_KEY": "gnubok_sk_..."\n' +
      '      }\n' +
      '    }\n' +
      '  }\n' +
      '}\n'
  )
  process.exit(1)
}

let buffer = ''

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk

  let newlineIdx
  while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newlineIdx).trim()
    buffer = buffer.slice(newlineIdx + 1)

    if (!line) continue

    handleMessage(line).catch((err) => {
      process.stderr.write(`accounted-mcp error: ${err.message}\n`)
    })
  }
})

process.stdin.on('end', () => {
  process.exit(0)
})

async function handleMessage(line) {
  let parsed
  try {
    parsed = JSON.parse(line)
  } catch {
    process.stderr.write('accounted-mcp: invalid JSON\n')
    return
  }

  const isNotification = parsed.id === undefined || parsed.id === null

  try {
    const res = await fetch(MCP_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
        ...(CLIENT ? { 'X-Accounted-Client': CLIENT } : {}),
      },
      body: line,
    })

    if (res.status === 202 || res.status === 204) {
      return
    }

    const responseText = await res.text()

    // Guard against non-JSON error responses such as CDN or proxy pages.
    if (!res.ok && !isNotification) {
      let message = `HTTP ${res.status}`
      try {
        const json = JSON.parse(responseText)
        if (json.error) {
          message =
            typeof json.error === 'string'
              ? json.error
              : JSON.stringify(json.error)
        }
      } catch {
        // The body was not JSON: use the generic HTTP status message.
      }
      const errorResponse = JSON.stringify({
        jsonrpc: '2.0',
        id: parsed.id,
        error: { code: -32000, message },
      })
      process.stdout.write(`${errorResponse}\n`)
      return
    }

    if (responseText) {
      process.stdout.write(`${responseText}\n`)
    }
  } catch (err) {
    if (!isNotification) {
      const errorResponse = JSON.stringify({
        jsonrpc: '2.0',
        id: parsed.id,
        error: { code: -32000, message: `Connection error: ${err.message}` },
      })
      process.stdout.write(`${errorResponse}\n`)
    }
  }
}
