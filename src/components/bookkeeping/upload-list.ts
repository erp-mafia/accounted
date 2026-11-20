import type { UploadedFile } from './DocumentUploadZone'

/**
 * A change DocumentUploadZone makes to its host's file list, applied to the
 * list as it is when the change lands. A useState setter takes it as is.
 *
 * The zone used to report whole lists built from the list its drop started
 * from, and an upload finishes long after its drop: by then another drop, a
 * removal or the host's own change may have landed, and the stale list
 * undid it. Two overlapping drops lost the second file and left the first
 * one "uploading" for good, and a file removed while another one uploaded
 * came back (crm#1101). An update of the latest list can do neither, also
 * when the zone that started the upload is no longer mounted.
 */
export type UploadedFilesUpdate = (files: UploadedFile[]) => UploadedFile[]

/** Dropped files join the end of the list. */
export function addUploads(added: readonly UploadedFile[]): UploadedFilesUpdate {
  return (files) => [...files, ...added]
}

/**
 * An upload finished, uploaded or failed: its result takes its place, by
 * uploadKey. A file the host no longer lists stays out, and the list is
 * then handed back as it was.
 */
export function finishUpload(result: UploadedFile): UploadedFilesUpdate {
  return (files) =>
    files.some((f) => f.uploadKey === result.uploadKey)
      ? files.map((f) => (f.uploadKey === result.uploadKey ? result : f))
      : files
}

/** The x on a file in the list. */
export function removeUpload(uploadKey: string): UploadedFilesUpdate {
  return (files) => files.filter((f) => f.uploadKey !== uploadKey)
}
