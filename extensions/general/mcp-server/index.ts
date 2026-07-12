import type { Extension } from '@/lib/extensions/types'
import { handleMcpRequest, tools as mcpTools } from './server'
import { isForbiddenOrigin, forbiddenOriginResponse } from './origin-guard'
import { registerAgentTools } from '@/lib/agent/tools/registry'
import type { AgentTool } from '@/lib/agent/tools/types'

// Make the same tool set available to the in-app chat agent. The chat loop
// (lib/agent/chat/*) dispatches against the core agentToolRegistry so it can
// stay decoupled from this extension's module path. Tools satisfy the
// AgentTool contract structurally: see lib/agent/tools/types.ts.
registerAgentTools(mcpTools as unknown as AgentTool[])

export const mcpServerExtension: Extension = {
  id: 'mcp-server',
  name: 'MCP Server',
  version: '1.0.0',

  settingsPanel: {
    label: 'MCP-server (API)',
    path: '/settings/api',
  },

  apiRoutes: [
    {
      method: 'POST',
      path: '/mcp',
      skipAuth: true, // Auth handled via API key in the handler
      handler: async (request: Request) => {
        // MCP spec MUST: validate Origin (DNS-rebinding defense). See origin-guard.ts.
        if (isForbiddenOrigin(request)) return forbiddenOriginResponse()
        return handleMcpRequest(request)
      },
    },
    // MCP Streamable HTTP also needs GET for SSE and DELETE for session termination
    {
      method: 'GET',
      path: '/mcp',
      skipAuth: true,
      // This server is stateless and offers no server-initiated SSE stream, so
      // the Streamable HTTP spec requires 405 Method Not Allowed here. Returning
      // 401 (as we previously did) makes spec-compliant clients (Claude
      // connector, Claude Desktop, Cursor) treat the SSE GET as an auth failure
      // and retry-loop: refresh token → re-open GET → 401 → …: which storms
      // the endpoint and churns OAuth key rotation. OAuth discovery is
      // bootstrapped on the POST 401 (WWW-Authenticate), not here.
      handler: async (request: Request) => {
        if (isForbiddenOrigin(request)) return forbiddenOriginResponse()
        return new Response('Method Not Allowed', {
          status: 405,
          headers: { Allow: 'POST, DELETE' },
        })
      },
    },
    {
      method: 'DELETE',
      path: '/mcp',
      skipAuth: true,
      // Stateless: no sessions to terminate
      handler: async (request: Request) => {
        if (isForbiddenOrigin(request)) return forbiddenOriginResponse()
        return new Response(null, { status: 204 })
      },
    },
  ],

  eventHandlers: [],
}
