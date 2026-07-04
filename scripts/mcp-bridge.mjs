#!/usr/bin/env node
/**
 * Stdio-to-HTTP bridge for Claude Desktop.
 * Reads JSON-RPC from stdin, POSTs to the gnubok MCP endpoint, writes response to stdout.
 *
 * Usage in claude_desktop_config.json:
 * {
 *   "mcpServers": {
 *     "gnubok": {
 *       "command": "node",
 *       "args": ["/path/to/erp-base/scripts/mcp-bridge.mjs"],
 *       "env": {
 *         "GNUBOK_API_KEY": "gnubok_sk_...",
 *         "GNUBOK_URL": "http://localhost:3000/api/extensions/ext/mcp-server/mcp"
 *       }
 *     }
 *   }
 * }
 */

const API_KEY = process.env.GNUBOK_API_KEY
const URL = process.env.GNUBOK_URL || 'http://localhost:3000/api/extensions/ext/mcp-server/mcp'

if (!API_KEY) {
  process.stderr.write('Error: GNUBOK_API_KEY environment variable is required\n')
  process.exit(1)
}

let buffer = ''

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk

  // JSON-RPC messages are newline-delimited
  let newlineIdx
  while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newlineIdx).trim()
    buffer = buffer.slice(newlineIdx + 1)

    if (!line) continue

    handleMessage(line).catch((err) => {
      process.stderr.write(`Bridge error: ${err.message}\n`)
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
    process.stderr.write(`Invalid JSON: ${line}\n`)
    return
  }

  // Notifications (no id) don't expect a response, but still forward them
  const isNotification = parsed.id === undefined || parsed.id === null

  try {
    const res = await fetch(URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
      },
      body: line,
    })

    if (res.status === 204) {
      // No content (e.g. notifications/initialized): nothing to write back
      return
    }

    const text = await res.text()
    if (text) {
      process.stdout.write(text + '\n')
    }
  } catch (err) {
    if (!isNotification) {
      const errorResponse = JSON.stringify({
        jsonrpc: '2.0',
        id: parsed.id,
        error: { code: -32000, message: `Bridge error: ${err.message}` },
      })
      process.stdout.write(errorResponse + '\n')
    }
  }
}
