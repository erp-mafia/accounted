/**
 * Walking the element tree InvoicePDF() returns, the way the template tests
 * read it without a full render (test helper, not a test file).
 *
 * The page number, the running header and the payment area are drawn by
 * react-pdf `render` callbacks: they only exist once react-pdf knows the page
 * (the payment area only on the last one). The walk calls each callback for
 * the page it is told to read, by default page 1 of 1, so a one-page
 * invoice reads like the PDF it becomes.
 */
import type { ReactElement, ReactNode } from 'react'

export type AnyElement = ReactElement<Record<string, unknown> & { children?: ReactNode }>

export interface PdfTreePage {
  pageNumber: number
  totalPages: number
}

export const ONLY_PAGE: PdfTreePage = { pageNumber: 1, totalPages: 1 }

/** What the element stands for on `page`: its children, plus what its render callback draws there. */
function contentOf(element: AnyElement, page: PdfTreePage): ReactNode[] {
  const out: ReactNode[] = [element.props.children]
  const render = element.props.render
  if (typeof render === 'function') {
    out.push((render as (context: PdfTreePage & { subPageNumber: number; subPageTotalPages: number }) => ReactNode)({
      ...page,
      subPageNumber: 1,
      subPageTotalPages: 1,
    }))
  }
  return out
}

/** Every React element in the tree, in document order. */
export function treeElements(node: ReactNode, page: PdfTreePage = ONLY_PAGE, out: AnyElement[] = []): AnyElement[] {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') return out
  if (Array.isArray(node)) {
    for (const child of node) treeElements(child, page, out)
    return out
  }
  const element = node as AnyElement
  out.push(element)
  if (element.props) treeElements(contentOf(element, page), page, out)
  return out
}

/** Every string leaf in the tree, in document order. */
export function treeTextLeaves(node: ReactNode, page: PdfTreePage = ONLY_PAGE, out: string[] = []): string[] {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) treeTextLeaves(child, page, out)
    return out
  }
  const element = node as AnyElement
  if (element.props) treeTextLeaves(contentOf(element, page), page, out)
  return out
}

/** The tree's text as one string, a line per leaf. */
export function treeText(node: ReactNode, page: PdfTreePage = ONLY_PAGE): string {
  return treeTextLeaves(node, page).join('\n')
}

export function styleOf(el: AnyElement): Record<string, unknown> {
  const style = el.props.style
  if (Array.isArray(style)) return Object.assign({}, ...style)
  return (style ?? {}) as Record<string, unknown>
}

export function containsText(el: AnyElement, needle: string, page: PdfTreePage = ONLY_PAGE): boolean {
  return treeTextLeaves(contentOf(el, page), page).some((leaf) => leaf.includes(needle))
}
