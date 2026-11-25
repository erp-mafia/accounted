// The SQL repeats this rule where a TypeScript function cannot reach, and this
// guard does not scan SQL: guard_document_storage_path (newest in
// supabase/migrations/20261123092000_document_storage_path_inside_company.sql)
// keeps a member's document_attachments.storage_path inside the row's
// company, and guard_reconciliation_attachment_storage_path (newest in
// supabase/migrations/20261125162000_reconciliation_attachment_key_inside_company.sql)
// keeps a member's account_reconciliation_attachments bucket and key in the
// company's folder of the documents bucket (isCompanyFolderObject). Those
// copies are acceptable because each side names the other, and
// tests/pg/document-storage-path-inside-company.pg.test.ts and
// tests/pg/reconciliation-attachment-key-inside-company.pg.test.ts pin them on
// the cases src/lib/core/documents/__tests__/storage-key.test.ts pins this home on.
export default {
  rule: 'document-key-of-company',
  says: "The service role reads, signs or removes a document row's stored key only when the key lies inside the row's own company: its folder documents/{companyId}/..., or a legacy uploader key one folder deep, with no empty, '.' or '..' part and no character a URL reads differently.",
  home: 'src/lib/core/documents/storage-key.ts: isDocumentKeyOfCompany, isCompanyFolderDocumentKey, documentStoragePathCandidates, downloadDocumentObject, isCompanyFolderObject, downloadCompanyFolderObject, signDocumentObject',
  why: "Routes, crons, agent tools and the archive export each handed a document's stored key to Storage on their own; one rule behind every door keeps them from disagreeing.",
  match: [
    // A row's stored key handed to Storage directly.
    /\.(download|createSignedUrl|createSignedUrls)\(\s*[\w.!?]*\bstorage_path\b/,
    /\.remove\(\s*\[[^\]]*\bstorage_path\b/,
  ],
  sanctioned: ['lib/core/documents/storage-key.ts'],
  allowed: {},
}
