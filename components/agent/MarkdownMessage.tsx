'use client'

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/**
 * Isolated so AgentChat can load the markdown parser (react-markdown +
 * remark-gfm and their unified/remark dependency tree) via next/dynamic:
 * the chunk is fetched when the first assistant message renders instead of
 * being parsed eagerly whenever the chat surface mounts.
 */
export default function MarkdownMessage({ text }: { text: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
}
