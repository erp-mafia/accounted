import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * A knowledge item's text, in the picture's Kunskap panel and on the item's
 * own page (both KnowledgeItemView) and on the catalogue's item page
 * (ItemDetail): shown from after the file's front matter, while the copy
 * control still copies the whole text the agent reads. The rule itself is
 * tested in lib/agent-skills/__tests__/front-matter.test.ts.
 */
const read = (file: string) => fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8')
const VIEW_SRC = read('KnowledgeItemView.tsx')
const DETAIL_SRC = read('ItemDetail.tsx')
const PAGE_SRC = read('KnowledgeItemPage.tsx')
const FOLDERS_SRC = read('KnowledgeFolders.tsx')

describe('a knowledge item\'s text is shown without its front matter', () => {
  it('renders the text from after the front matter in the knowledge item view', () => {
    expect(VIEW_SRC).toContain("import { stripFrontMatter } from '@/lib/agent-skills/front-matter'")
    expect(VIEW_SRC).toContain('<Markdown text={stripFrontMatter(body.data)} />')
    expect(VIEW_SRC).not.toContain('<Markdown text={body.data} />')
  })

  it('copies the whole text, front matter included', () => {
    expect(VIEW_SRC).toContain("<CopyIcon text={body.data} label={t('copy_contents')} />")
    expect(DETAIL_SRC).toContain("<CopyIcon text={body.data} label={t('copy_contents')} />")
    expect(VIEW_SRC).not.toMatch(/CopyIcon text=\{stripFrontMatter/)
    expect(DETAIL_SRC).not.toMatch(/CopyIcon text=\{stripFrontMatter/)
  })

  it('is the one view both the panel and the item\'s own page show', () => {
    expect(PAGE_SRC).toContain('<KnowledgeItemView option={option} companyId={companyId} />')
    expect(FOLDERS_SRC).toContain('<KnowledgeItemView option={opened} companyId={company.id} />')
  })

  it('renders the same text the same way on the catalogue\'s item page', () => {
    const contents = DETAIL_SRC.slice(DETAIL_SRC.indexOf('<div id="item-body"'))
    expect(contents.slice(0, contents.indexOf('</div>'))).toContain('<Markdown text={stripFrontMatter(body.data)} />')
  })

  it('still hands an own item\'s whole text to the editor', () => {
    expect(DETAIL_SRC).toContain("description: mine!.summary ?? '', body: body.data,")
  })
})
