---
name: accounted-gather
description: Gather the documents an Accounted company is missing. Use when the person asks to find, fetch, collect or upload what Accounted says is missing (loan agreements, rental agreements, insurance letters, registration certificates), or asks what is missing in their bookkeeping archive. Requires the Accounted MCP connection and, for searching, the person's own mail, drive or file connectors.
---

# Gather what Accounted is missing

Accounted keeps the company's documents as records. Its nightly check compares the bookkeeping with the archive and lists documents that should exist but do not, for example interest paid every month with no loan agreement on file. This skill turns that list into found documents, with the person approving every upload.

## Steps

1. Read the resource `Accounted://arkiv/missing`. It holds `missing[]` with `finding_id`, `label`, `evidence`, `hint` and `since`, and `intake.email`, the company's forwarding address. If `missing` is empty, say so and stop.
2. For each item, search the sources the person has given you access to, in this order: their mailbox (search the counterparty name and words from `hint`), their drive or file folders, then ask the person where it might be. Prefer the newest signed version. Never invent a document and never guess which of two versions applies; ask.
3. Show the person what you found: file name, sender or folder, date. Ask before uploading. One question for all items at once is better than one question per item.
4. Upload an approved file with `gnubok_create_document_upload` followed by `gnubok_complete_document_upload` (or, when the document is an email attachment and the person prefers it, forward the mail to `intake.email`). Accounted reads it, classifies it and files it by itself; you do not need to say what it is.
5. Close the item with `gnubok_resolve_missing`: `resolution: "uploaded"` with the document's `record_ref` when you uploaded it, `not_exists` when the person says no such document exists, `not_applicable` when the person says the item does not apply to them. The two latter answers are remembered; Accounted will not ask again.
6. Report in plain words: what was found and uploaded, what was closed as not existing or not applicable, what is still open and where you looked.

## Rules

- Only upload what the person approved in this conversation.
- Do not upload the same file twice; Accounted rejects duplicates by content, and a second copy of an older version is noise.
- Do not resolve an item as `not_exists` or `not_applicable` on your own judgement; those answers come from the person.
- Keep the person's mailbox private: quote subjects and senders, never paste whole emails into the conversation.
- Everything Accounted reads keeps its source page; if the person later asks what a document says, `gnubok_ask_document` answers with the page and the quote.
