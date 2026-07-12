#!/usr/bin/env node
/**
 * gnubok-mcp: Connect Claude Desktop to your Accounted bookkeeping account.
 *
 * Usage in claude_desktop_config.json:
 * {
 *   "mcpServers": {
 *     "gnubok": {
 *       "command": "npx",
 *       "args": ["gnubok-mcp"],
 *       "env": {
 *         "GNUBOK_API_KEY": "gnubok_sk_..."
 *       }
 *     }
 *   }
 * }
 *
 * Get your API key at: https://app.gnubok.se/settings?tab=api
 */

const API_KEY = process.env.GNUBOK_API_KEY
const MCP_URL = process.env.GNUBOK_URL || 'https://app.gnubok.se/api/extensions/ext/mcp-server/mcp'
// Optional distribution-channel marker (e.g. 'openclaw'). Forwarded as
// X-Gnubok-Client and recorded in server telemetry only, never affects auth.
// Mirrors the server's allow-list so an invalid value degrades to "no header"
// instead of fetch() rejecting every request with an invalid-header error.
const rawClient = process.env.GNUBOK_CLIENT
const CLIENT = rawClient && /^[A-Za-z0-9._-]{1,64}$/.test(rawClient) ? rawClient : undefined
if (rawClient && !CLIENT) {
  process.stderr.write('gnubok-mcp: ignoring GNUBOK_CLIENT: must match [A-Za-z0-9._-]{1,64}\n')
}

if (!API_KEY) {
  process.stderr.write(
    'Error: GNUBOK_API_KEY is required.\n' +
    'Get your API key at: https://app.gnubok.se/settings?tab=api\n' +
    '\n' +
    'Add it to your Claude Desktop config:\n' +
    '{\n' +
    '  "mcpServers": {\n' +
    '    "gnubok": {\n' +
    '      "command": "npx",\n' +
    '      "args": ["gnubok-mcp"],\n' +
    '      "env": {\n' +
    '        "GNUBOK_API_KEY": "gnubok_sk_..."\n' +
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
      process.stderr.write(`gnubok-mcp error: ${err.message}\n`)
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
    process.stderr.write(`gnubok-mcp: invalid JSON\n`)
    return
  }

  const isNotification = parsed.id === undefined || parsed.id === null

  try {
    const res = await fetch(MCP_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
        ...(CLIENT ? { 'X-Gnubok-Client': CLIENT } : {}),
      },
      body: line,
    })

    if (res.status === 202 || res.status === 204) {
      return
    }

    const text = await res.text()

    // Guard against non-JSON error responses (CDN HTML pages, proxy errors)
    if (!res.ok && !isNotification) {
      let message = `HTTP ${res.status}`
      try {
        const json = JSON.parse(text)
        if (json.error) message = typeof json.error === 'string' ? json.error : JSON.stringify(json.error)
      } catch { /* body wasn't JSON: use generic message */ }
      const errorResponse = JSON.stringify({
        jsonrpc: '2.0',
        id: parsed.id,
        error: { code: -32000, message },
      })
      process.stdout.write(errorResponse + '\n')
      return
    }

    if (text) {
      process.stdout.write(text + '\n')
    }
  } catch (err) {
    if (!isNotification) {
      const errorResponse = JSON.stringify({
        jsonrpc: '2.0',
        id: parsed.id,
        error: { code: -32000, message: `Connection error: ${err.message}` },
      })
      process.stdout.write(errorResponse + '\n')
    }
  }
}
