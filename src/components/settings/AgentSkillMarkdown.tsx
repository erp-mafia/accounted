'use client'

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/**
 * Isolated so AgentSkillsPanel can load the markdown parser (react-markdown +
 * remark-gfm and their unified/remark tree) via next/dynamic: the chunk is
 * fetched when the first knowledge area is opened, not with the settings page.
 */
export default function AgentSkillMarkdown({ body }: { body: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
}
