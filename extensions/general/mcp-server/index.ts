import type { Extension } from '@/lib/extensions/types'
import { handleMcpRequest, tools as mcpTools } from './server'
import { registerAgentTools } from '@/lib/agent/tools/registry'
import type { AgentTool } from '@/lib/agent/tools/types'

// Make the same tool set available to the in-app chat agent. The chat loop
// (lib/agent/chat/*) dispatches against the core agentToolRegistry so it can
// stay decoupled from this extension's module path. Tools satisfy the
// AgentTool contract structurally — see lib/agent/tools/types.ts.
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
      handler: handleMcpRequest,
    },
    // MCP Streamable HTTP also needs GET for SSE and DELETE for session termination
    {
      method: 'GET',
      path: '/mcp',
      skipAuth: true,
      handler: async () => {
        const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
        return new Response('Authorization required', {
          status: 401,
          headers: {
            'WWW-Authenticate': `Bearer resource_metadata="${appUrl}/.well-known/oauth-protected-resource"`,
          },
        })
      },
    },
    {
      method: 'DELETE',
      path: '/mcp',
      skipAuth: true,
      handler: async () => new Response(null, { status: 204 }), // Stateless — no sessions to terminate
    },
  ],

  eventHandlers: [],
}
