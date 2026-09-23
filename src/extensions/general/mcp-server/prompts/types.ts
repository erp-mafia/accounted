/**
 * MCP prompt: a server-defined chat template the user picks from a slash menu
 * in their MCP client. Selecting a prompt sends the message text to the model,
 * which then calls the relevant Accounted tools to satisfy the request.
 *
 * These prompts are intentionally argument-less and single-action: each one
 * maps to one read tool, returning one short answer in Swedish.
 */
export interface McpPrompt {
  name: string
  description: string
  /** The user-role message text the client sends to the model. */
  text: string
}
