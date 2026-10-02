# SIE Migration Between Systems and Audit Trail

## Migration between systems

Standard path: export SIE4E per fiscal year from source, import into target starting with current year, verify IB/UB continuity, remap verification series to avoid collisions.

**What SIE does NOT carry**: VAT codes (must be manually configured post-import), customer/supplier subledgers (reskontror), processing history, underlying digital documents/vouchers.

Post-migration validation: compare balance reports, trial balances, verification counts per series, Swedish character rendering.

Per-error handling for the post-import gaps (missing VAT codes, missing subledger data, verification series remapping) is in `validation-rules.md`.

## Audit trail under BFL

- **7-year retention** after calendar year in which fiscal year ended (BFL 7:2)
- **Storage in Sweden** is the main rule (BFL 7:2). Electronic records may be kept in another EU country, or in a non-EU country with equivalent mutual-assistance instruments, if the location (and any change) is reported to Skatteverket, Skatteverket/Tullverket get immediate electronic access on request, and a printout can be made immediately in Sweden (BFL 7:3a). Otherwise a permit from Skatteverket is needed (BFL 7:4). Paper records stay in Sweden; only a paper verifikation may be kept abroad temporarily, for special reasons (BFL 7:3).
- **Immutability**: locked entries cannot be modified. Corrections via separate correction verification only.
- **#FLAGGA**: anti-duplication control. Exporter writes 0, importer sets to 1 after success.
- **SIE is not complete archiving**: lacks processing history and system documentation required by BFL.
- As of July 2024, paper originals may be destroyed after proper digitization.
