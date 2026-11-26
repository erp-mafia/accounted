import { describe, expect, it } from 'vitest'
import { pageDropUploads, splitPageDrop } from '../page-drop'

describe('pageDropUploads', () => {
  it('uploads a drop on Behöver dig and on a door', () => {
    expect(pageDropUploads({ kind: 'need' })).toBe(true)
    expect(pageDropUploads({ kind: 'door', door: 'upload' })).toBe(true)
  })

  it('leaves Saknar underlag to its own drop on the purchase', () => {
    expect(pageDropUploads({ kind: 'missing' })).toBe(false)
    expect(pageDropUploads({ kind: 'missing', portal: 'Telia' })).toBe(false)
  })
})

describe('splitPageDrop', () => {
  it('sends PDFs and photos, counts what the inbox route would refuse', () => {
    const pdf = { name: 'kvitto.pdf', type: 'application/pdf' }
    const jpg = { name: 'kvitto.jpg', type: 'image/jpeg' }
    const heic = { name: 'IMG_1.heic', type: 'image/heic' }
    const docx = { name: 'avtal.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }
    const folder = { name: 'Kvitton', type: '' }
    expect(splitPageDrop([pdf, docx, jpg, folder, heic])).toEqual({ upload: [pdf, jpg, heic], refused: [docx, folder] })
  })

  it('takes an empty drop as nothing to send', () => {
    expect(splitPageDrop([])).toEqual({ upload: [], refused: [] })
  })
})
