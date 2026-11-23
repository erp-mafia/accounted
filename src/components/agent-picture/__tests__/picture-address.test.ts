/**
 * The agent picture and the address (lib/agent-context/wiki-views.ts says
 * what an address names; its own test covers that). Here: the components
 * hand the named row and item down to where they open, closing takes them
 * out of the address through the History API with no navigation, and a row
 * opened from the card is not written to the address.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
const wikiViews = read('src/components/wiki/WikiViews.tsx')
const contextView = read('src/components/wiki/ContextView.tsx')
const picture = read('src/components/agent-picture/AgentPicture.tsx')
const views = read('src/components/agent-picture/PictureViews.tsx')
const folders = read('src/components/skills/KnowledgeFolders.tsx')

describe('the picture opens on what the address names', () => {
  it('reads the row and the item from the address in one place and hands them down', () => {
    expect(wikiViews).toContain("wikiPlace({ view: searchParams.get('view'), item: searchParams.get(PICTURE_ITEM_PARAM) }, { picture, facts })")
    expect(wikiViews).toContain("row={place.show === 'picture' ? place.row : null}")
    expect(wikiViews).toContain("item={place.show === 'picture' ? place.item : null}")
    expect(contextView).toMatch(/<AgentPicture\s+row=\{row\}\s+item=\{item\}/)
  })

  it('starts with the named row open, and opens a row the address comes to name', () => {
    expect(picture).toContain('const [view, setView] = useState<PictureView | null>(row)')
    expect(picture).toMatch(/if \(row !== namedRow\) \{\s+setNamedRow\(row\)\s+if \(row\) setView\(row\)\s+\}/)
  })

  it('opens the Kunskap view on the named item, and one the address comes to name', () => {
    expect(views).toContain('<KnowledgeFolders active={activeKnowledge} item={knowledgeItem} onItemClose={onKnowledgeItemClose} />')
    expect(folders).toContain('useState<string | null>(item ? knowledgeItemId(item) : null)')
    expect(folders).toMatch(/if \(item !== namedItem\) \{\s+setNamedItem\(item\)\s+if \(item\) setOpenId\(knowledgeItemId\(item\)\)\s+\}/)
  })

  it('reads the agent card from the address in the same place and hands it down, and opens its panel', () => {
    expect(wikiViews).toContain("pictureAgentOf({ view: searchParams.get('view'), agent: searchParams.get(PICTURE_AGENT_PARAM) })")
    expect(wikiViews).toContain('agent={agent}')
    expect(contextView).toMatch(/<AgentPicture\s+row=\{row\}\s+item=\{item\}\s+agent=\{agent\}/)
    expect(picture).toContain('const [agentCard, setAgentCard] = useState<string | null>(agent)')
    expect(picture).toMatch(/if \(agent !== namedAgent\) \{\s+setNamedAgent\(agent\)\s+if \(agent\) setAgentCard\(agent\)\s+\}/)
    // The panel is the rows' own side panel, and a row wins when the address names both.
    expect(views).toContain("const current: Shown | null = sheet ? { sheet } : view === null && agent ? { agent } : null")
    expect(views.match(/<SlideOver /g)).toHaveLength(1)
  })

  it('keeps the menu on the picture row whichever row the address names', () => {
    expect(wikiViews).toContain("useClaimNavRow(WIKI_PATH, place.show === 'picture' ? WIKI_PATH : null)")
  })
})

describe('closing takes the row out of the address without a navigation', () => {
  it('rewrites the address with the History API, and only when it names something', () => {
    expect(picture).toMatch(/function forgetInAddress[\s\S]*?const next = withoutPictureRow\(here, options\)\s+if \(next !== here\) window\.history\.replaceState\(null, '', next\)/)
    // No router and no location assignment: nothing here loads the page again.
    expect(picture).not.toMatch(/useRouter|router\.(push|replace|refresh)|location\.(assign|replace|href\s*=)/)
    expect(folders).not.toMatch(/useRouter|router\.(push|replace|refresh)|location\.(assign|replace|href\s*=)/)
  })

  it('forgets the row when its view closes, and the item alone when its folder is left', () => {
    expect(picture).toMatch(/const closeView = useCallback\(\(\) => \{[\s\S]*?setView\(null\)\s+forgetInAddress\(\)\s+\}, \[\]\)/)
    expect(picture).toContain('onKnowledgeItemClose={() => forgetInAddress({ keepRow: true })}')
    expect(folders).toMatch(/setOpenId\(null\)\s+onItemClose\?\.\(\)/)
  })

  it('forgets the agent card when its panel closes', () => {
    expect(picture).toMatch(/const closeView = useCallback\(\(\) => \{[\s\S]*?setAgentCard\(null\)\s+setView\(null\)\s+forgetInAddress\(\)\s+\}, \[\]\)/)
  })

  it('opens an agent card by a press in place: a button with state only, no link away and nothing written to the address', () => {
    expect(picture).toContain('onOpenAgent={setAgentCard}')
    expect(picture).toContain("onPress={card.state === 'connected' ? () => onOpenAgent(card.id) : undefined}")
    expect(picture).toMatch(/if \(onPress\) \{\s+return \(\s+<button type="button" data-picture-agent=\{flowId\} onClick=\{onPress\} \{\.\.\.flow\}>/)
  })

  it('opens a row from the card as before: state only, nothing written to the address', () => {
    expect(picture).toContain('onOpen={setView}')
    // The address is written in one place, and that place only ever removes.
    expect(picture.match(/history\.(replaceState|pushState)/g)).toEqual(['history.replaceState'])
  })
})
