/**
 * MCP Apps inline widget contract.
 *
 * Each widget is a self-contained HTML document rendered in an iframe by
 * MCP Apps hosts (Claude Desktop, Claude Web). Widgets communicate with
 * the host exclusively via postMessage / JSON-RPC 2.0; never via fetch().
 */
export interface UiWidget {
  /** Resource URI clients use to load the widget: e.g. `ui://vat-review/app.html`. */
  uri: string
  /** Display name shown in the host's resource list. */
  name: string
  /** One-line description shown alongside the resource. */
  description: string
  /** Self-contained HTML document (no external network access). */
  html: string
}

export const WIDGET_MIME_TYPE = 'text/html;profile=mcp-app' as const
