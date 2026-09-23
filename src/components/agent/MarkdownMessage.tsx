'use client'

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import Link from 'next/link'
import { isInternalHref } from './markdown-links'

/**
 * Isolated so AgentChat can load the markdown parser (react-markdown +
 * remark-gfm and their unified/remark dependency tree) via next/dynamic:
 * the chunk is fetched when the first assistant message renders instead of
 * being parsed eagerly whenever the chat surface mounts.
 */
export default function MarkdownMessage({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: MarkdownLink }}>
      {text}
    </ReactMarkdown>
  )
}

/**
 * Links inside an answer.
 *
 * These were plain anchors, so following one the agent had written did a full
 * document load: the whole app rebooted and the conversation went with it, in
 * the panel and in /chat alike. Internal links now route client-side, which
 * keeps the thread alive beside the page the user just opened, which is the
 * point of docking the panel in the first place.
 *
 * External links open in a new tab for the same reason, and carry
 * rel="noopener noreferrer": the href came out of a model that reads customer
 * documents, and target="_blank" without it hands the opened page a
 * window.opener handle back into an authenticated session.
 */
function MarkdownLink({
  href,
  title,
  children,
}: {
  href?: string
  // Markdown carries an optional title: [text](url "title"). Dropping it here
  // would silently discard something the answer's author wrote.
  title?: string
  children?: React.ReactNode
}) {
  if (!href) return <>{children}</>

  if (isInternalHref(href)) {
    return (
      <Link href={href} title={title} className="underline underline-offset-2">
        {children}
      </Link>
    )
  }

  return (
    <a
      href={href}
      title={title}
      target="_blank"
      rel="noopener noreferrer"
      className="underline underline-offset-2"
    >
      {children}
    </a>
  )
}
