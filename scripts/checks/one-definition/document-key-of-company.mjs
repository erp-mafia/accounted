// The SQL repeats this rule: guard_document_storage_path (newest in
// supabase/migrations/20261123092000_document_storage_path_inside_company.sql)
// keeps a member's document_attachments.storage_path inside the row's
// company, where a TypeScript function cannot reach, and this guard does not
// scan SQL. That copy is acceptable because both name each other, and
// tests/pg/document-storage-path-inside-company.pg.test.ts pins it on the
// cases src/lib/core/documents/__tests__/storage-key.test.ts pins this home on.
export default {
  rule: 'document-key-of-company',
  says: "The service role reads, signs or removes a document row's stored key only when the key lies inside the row's own company: its folder documents/{companyId}/..., or a legacy uploader key one folder deep, with no empty, '.' or '..' part and no character a URL reads differently.",
  home: 'src/lib/core/documents/storage-key.ts: isDocumentKeyOfCompany, isCompanyFolderDocumentKey, documentStoragePathCandidates, downloadDocumentObject, downloadCompanyFolderObject, signDocumentObject',
  why: "Routes, crons, agent tools and the archive export each handed a document's stored key to Storage on their own; one rule behind every door keeps them from disagreeing.",
  match: [
    // A row's stored key handed to Storage directly.
    /\.(download|createSignedUrl|createSignedUrls)\(\s*[\w.!?]*\bstorage_path\b/,
    /\.remove\(\s*\[[^\]]*\bstorage_path\b/,
  ],
  sanctioned: ['lib/core/documents/storage-key.ts'],
  allowed: {},
}
