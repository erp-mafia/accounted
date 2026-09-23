import { describe, it, expect } from 'vitest'
import { compareArticles, sortArticles } from '@/lib/articles/sort'

describe('sortArticles', () => {
  it('orders by article number numerically, not alphabetically', () => {
    const sorted = sortArticles([
      { article_number: '10', name: 'Tio' },
      { article_number: '2', name: 'Två' },
      { article_number: '1', name: 'Ett' },
    ])
    expect(sorted.map((a) => a.article_number)).toEqual(['1', '2', '10'])
  })

  it('reproduces issue #1053: numbered register no longer sorts by name', () => {
    const sorted = sortArticles([
      { article_number: '2', name: 'Delbehandling' },
      { article_number: '4', name: 'Fotvårdsremiss 85+' },
      { article_number: '5', name: 'Fotvårdsremiss ej frikort' },
      { article_number: '3', name: 'Fotvårdsremiss frikort' },
      { article_number: '1', name: 'Medicinsk fotvård' },
    ])
    expect(sorted.map((a) => a.article_number)).toEqual(['1', '2', '3', '4', '5'])
  })

  it('puts articles without a number last, sorted by name', () => {
    const sorted = sortArticles([
      { article_number: null, name: 'Zeta' },
      { article_number: '7', name: 'Sju' },
      { article_number: null, name: 'Alfa' },
      { article_number: undefined, name: 'Beta' },
    ])
    expect(sorted.map((a) => a.name)).toEqual(['Sju', 'Alfa', 'Beta', 'Zeta'])
  })

  it('treats blank article numbers as unnumbered', () => {
    const sorted = sortArticles([
      { article_number: '  ', name: 'Blank' },
      { article_number: '1', name: 'Ett' },
    ])
    expect(sorted.map((a) => a.name)).toEqual(['Ett', 'Blank'])
  })

  it('breaks ties on equal numbers by name', () => {
    const sorted = sortArticles([
      { article_number: '1', name: 'B' },
      { article_number: '1', name: 'A' },
    ])
    expect(sorted.map((a) => a.name)).toEqual(['A', 'B'])
  })

  it('handles alphanumeric numbers with embedded digits', () => {
    const sorted = sortArticles([
      { article_number: 'A10', name: 'x' },
      { article_number: 'A2', name: 'y' },
    ])
    expect(sorted.map((a) => a.article_number)).toEqual(['A2', 'A10'])
  })

  it('does not mutate the input array', () => {
    const input = [
      { article_number: '2', name: 'b' },
      { article_number: '1', name: 'a' },
    ]
    sortArticles(input)
    expect(input.map((a) => a.article_number)).toEqual(['2', '1'])
  })

  it('compareArticles is exported for column sorters', () => {
    expect(compareArticles({ article_number: '2', name: 'x' }, { article_number: '10', name: 'y' })).toBeLessThan(0)
  })
})
