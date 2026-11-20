import { describe, it, expect, vi } from 'vitest'
import type { UploadedFile } from '@/components/bookkeeping/DocumentUploadZone'
import { addUploads, finishUpload, removeUpload, type UploadedFilesUpdate } from '@/components/bookkeeping/upload-list'
import { createUnderlagController, type UnderlagController } from '../underlag-controller'
import { removedUpload, uploadInFlight, type UnderlagWrite } from '../review-underlag'

/**
 * crm#1101: overlapping uploads in the booking dialogs (the Bokför review
 * and the manual booking dialog). Their upload zone reported whole lists
 * built from the list each drop started from, so
 *
 *  (a) a file dropped while another one uploaded vanished when the first
 *      landed, and the first stayed "uploading" when the second landed,
 *      which held the review's Bokför and "Byt" disabled until it closed;
 *  (b) a document removed with its x while another one uploaded came back
 *      when that one landed, listed as attached but left out of the booking.
 *
 * The zone now hands updates of the latest list (upload-list.ts). These run
 * both sequences through the dialogs' own handling over the real
 * controller, with the pin and take-off requests held open.
 */

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const OK: UnderlagWrite = { ok: true }
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function controllerForRow() {
  const pins: Array<(write: UnderlagWrite) => void> = []
  const unpins: Array<(write: UnderlagWrite) => void> = []
  const controller = createUnderlagController({
    read: () => ({ transactionId: 'tx-1', documentId: null }),
    pin: vi.fn(() => {
      const d = deferred<UnderlagWrite>()
      pins.push(d.resolve)
      return d.promise
    }),
    unpin: vi.fn(() => {
      const d = deferred<UnderlagWrite>()
      unpins.push(d.resolve)
      return d.promise
    }),
  })
  return { controller, pins, unpins }
}

/**
 * The dialogs' handling of their upload zones, as both write it (the source
 * is pinned in booking-dialog-underlag.test.ts): handleFilesChange hands the
 * x on a finished upload to letGo and applies every other update to the
 * latest list; letGo withdraws the document through the controller and
 * takes it out of the list once the row has let it go. `state` takes
 * updates as React's setter does. `render()` is the handleFilesChange one
 * render closed over: an upload's results arrive through the one its drop
 * closed over, the x through the current one.
 */
function bookingDialog(controller: UnderlagController) {
  let state: UploadedFile[] = []
  const lettingGo: Promise<void>[] = []
  async function letGo(docId: string) {
    if (!(await controller.withdraw(docId))) return
    state = state.filter((f) => f.id !== docId)
  }
  function render() {
    const uploadedFiles = state
    return function handleFilesChange(update: UploadedFilesUpdate) {
      const removed = removedUpload(uploadedFiles, update(uploadedFiles))
      if (removed?.id) {
        lettingGo.push(letGo(removed.id))
        return
      }
      state = update(state)
    }
  }
  return { files: () => state, render, lettingGo: () => Promise.all(lettingGo) }
}

function pending(key: string): UploadedFile {
  return { file: {} as File, status: 'uploading', fileName: `${key}.pdf`, fileSize: 1000, uploadKey: key }
}

function uploaded(file: UploadedFile): UploadedFile {
  return { ...file, status: 'uploaded', id: `doc-${file.uploadKey}` }
}

const statuses = (files: UploadedFile[]) => files.map((f) => `${f.uploadKey}:${f.status}`)

/** A lands and the dialog offers it to the row (onUploaded): the pin is answered. */
async function landAndPin(
  zone: (update: UploadedFilesUpdate) => void,
  file: UploadedFile,
  { controller, pins }: ReturnType<typeof controllerForRow>,
) {
  zone(finishUpload(uploaded(file)))
  const claimed = controller.claim(`doc-${file.uploadKey}`, file.fileName)
  await flush()
  pins[pins.length - 1](OK)
  await claimed
}

describe('(a) a file dropped while another one uploads', () => {
  it('stays listed, both land, and nothing is left on its way', async () => {
    const row = controllerForRow()
    const dialog = bookingDialog(row.controller)
    const a = pending('a')
    const b = pending('b')

    const dropA = dialog.render()
    dropA(addUploads([a]))
    const dropB = dialog.render()
    dropB(addUploads([b]))
    await landAndPin(dropA, a, row)
    expect(statuses(dialog.files())).toEqual(['a:uploaded', 'b:uploading'])

    dropB(finishUpload(uploaded(b)))
    // Held for the booking: the row already holds A.
    await expect(row.controller.claim('doc-b', 'b.pdf')).resolves.toBe(false)

    expect(statuses(dialog.files())).toEqual(['a:uploaded', 'b:uploaded'])
    // What Bokför and "Byt" wait for.
    expect(uploadInFlight(dialog.files())).toBe(false)
    expect(row.controller.state().busy).toBe(false)
    expect(row.controller.documentId()).toBe('doc-a')
  })

  it('also when the zone it was dropped in gave way to the viewer and a third file came in through the next one', async () => {
    // The manual booking dialog shows the row's underlag once A is pinned,
    // and a compact zone below it takes further files.
    const row = controllerForRow()
    const dialog = bookingDialog(row.controller)
    const a = pending('a')
    const b = pending('b')
    const c = pending('c')

    const firstZone = dialog.render()
    firstZone(addUploads([a, b]))
    await landAndPin(firstZone, a, row)
    const nextZone = dialog.render()
    nextZone(addUploads([c]))
    // B lands through the zone that is gone.
    firstZone(finishUpload(uploaded(b)))
    nextZone(finishUpload(uploaded(c)))

    expect(statuses(dialog.files())).toEqual(['a:uploaded', 'b:uploaded', 'c:uploaded'])
  })
})

describe('(b) a document removed while another one uploads', () => {
  it('does not come back when the other one lands after the row let it go', async () => {
    const row = controllerForRow()
    const dialog = bookingDialog(row.controller)
    const a = pending('a')
    const b = pending('b')

    const drop = dialog.render()
    drop(addUploads([a, b]))
    await landAndPin(drop, a, row)
    // The x on A, B still on its way.
    dialog.render()(removeUpload('a'))
    await flush()
    row.unpins[0](OK)
    await dialog.lettingGo()
    expect(statuses(dialog.files())).toEqual(['b:uploading'])

    drop(finishUpload(uploaded(b)))

    expect(dialog.files()).toEqual([uploaded(b)])
    expect(row.controller.isLetGo('doc-a')).toBe(true)
    expect(row.controller.documentId()).toBeNull()
  })

  it('stays listed while its take-off is on its way, and leaves once the row let it go', async () => {
    const row = controllerForRow()
    const dialog = bookingDialog(row.controller)
    const a = pending('a')
    const b = pending('b')

    const drop = dialog.render()
    drop(addUploads([a, b]))
    await landAndPin(drop, a, row)
    dialog.render()(removeUpload('a'))
    drop(finishUpload(uploaded(b)))
    expect(statuses(dialog.files())).toEqual(['a:uploaded', 'b:uploaded'])

    await flush()
    row.unpins[0](OK)
    await dialog.lettingGo()

    expect(dialog.files()).toEqual([uploaded(b)])
  })

  it('stays when the take-off is refused: still the row underlag, so still attached', async () => {
    const row = controllerForRow()
    const dialog = bookingDialog(row.controller)
    const a = pending('a')
    const b = pending('b')

    const drop = dialog.render()
    drop(addUploads([a, b]))
    await landAndPin(drop, a, row)
    dialog.render()(removeUpload('a'))
    drop(finishUpload(uploaded(b)))
    await flush()
    row.unpins[0]({ ok: false, status: 409, body: null })
    await dialog.lettingGo()

    expect(statuses(dialog.files())).toEqual(['a:uploaded', 'b:uploaded'])
    expect(row.controller.isLetGo('doc-a')).toBe(false)
    expect(row.controller.documentId()).toBe('doc-a')
  })
})
