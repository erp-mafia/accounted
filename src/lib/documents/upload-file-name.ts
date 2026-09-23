/**
 * The name of an uploaded file as the user saw it: the last path segment of
 * whatever the browser wrote into the multipart `filename` parameter.
 *
 * `File.name` in the browser is a bare filename by spec. The `filename` the
 * same browser writes into multipart/form-data is not guaranteed to be that
 * string: Chrome fills it with `webkitRelativePath` for files that came from
 * a folder selection. A receipt picked out of a Fortnox export as
 * `2026/06/Leverantörsfakturor/A166_Hetzner.pdf` therefore arrives server-side
 * under that whole path, while every client-side read of `file.name`, and so
 * every preview the user approved, said `A166_Hetzner.pdf`.
 *
 * Any server logic that compares an uploaded name to something the client
 * computed from `File.name`, or stores the name for the user to read back,
 * must go through this first. Both separators are stripped: Chrome writes `/`
 * on every platform, legacy Windows clients sent `\`. Nothing else is
 * normalized, on purpose: the voucher-ref parser must see the name exactly as
 * the exporting system wrote it.
 */
export function uploadedFileBaseName(name: string): string {
  const cut = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'))
  return cut === -1 ? name : name.slice(cut + 1)
}
