---
audience: developer
---

# SIE4 Character Encoding Reference

## The spec vs. reality

The SIE4 spec (still in utgåva 4C, 2025-08-06) allows only IBM PC Codepage 437 (declared as `#FORMAT PC8`). Modern cloud accounting software exports UTF-8. Many programs write `#FORMAT PC8` regardless of actual encoding. This mismatch is the single largest source of SIE interoperability failures.

## Byte values for Swedish characters

| Char | CP437 (hex) | Latin-1 (hex) | UTF-8 (hex) |
|------|-------------|---------------|-------------|
| å | 0x86 | 0xE5 | 0xC3 0xA5 |
| ä | 0x84 | 0xE4 | 0xC3 0xA4 |
| ö | 0x94 | 0xF6 | 0xC3 0xB6 |
| Å | 0x8F | 0xC5 | 0xC3 0x85 |
| Ä | 0x8E | 0xC4 | 0xC3 0x84 |
| Ö | 0x99 | 0xD6 | 0xC3 0x96 |
| é | 0x82 | 0xE9 | 0xC3 0xA9 |

## Mojibake diagnosis patterns

### UTF-8 bytes misread as Latin-1/CP1252
- å → `Ã¥`, ä → `Ã¤`, ö → `Ã¶`
- Å → `Ã…`, Ä → `Ã„`, Ö → `Ã–`
- **Telltale**: The `Ã` prefix always indicates UTF-8 content decoded as single-byte
- **Fix**: Re-read the file as UTF-8

### CP437 bytes misread as Latin-1/CP1252
- å → `†`, ä → `„`, ö → `”`
- Å → undefined in CP1252 (0x8F; shown as a control char or `�`), Ä → `Ž` (0x8E), Ö → `™`
- In strict ISO 8859-1, every byte 0x80-0x9F is a control character, so all six letters show as control chars or disappear
- **Telltale**: Typographic characters like `†„”™Ž` in account names
- **Fix**: Re-read the file as CP437

### Latin-1 bytes misread as CP437
- å → `σ`, ä → `Σ`, ö → `÷`
- **Telltale**: Greek letters or math symbols in Swedish text
- **Fix**: Re-read the file as Latin-1 (ISO 8859-1)

### Double-encoding (UTF-8 encoded twice)
- å → `Ã£Â¥` or similar multi-byte garbage
- **Telltale**: 3+ byte sequences where 2 were expected
- **Fix**: Decode as UTF-8, then decode the result as UTF-8 again (strip one layer)

## Encoding detection algorithm

Apply in this order, stop at first match:

1. **UTF-8 BOM check**: Bytes 0xEF 0xBB 0xBF at file start → UTF-8
2. **Strict UTF-8 validation**: Attempt full decode. If valid AND multi-byte sequences found → UTF-8. Pure ASCII files are ambiguous (proceed to next step).
3. **CP437 byte scan**: Look for bytes in range 0x80-0x9F in text contexts (account names, descriptions). If bytes 0x84, 0x86, 0x8E, 0x8F, 0x94, 0x99 appear → CP437
4. **Latin-1 byte scan**: Look for bytes in range 0xC0-0xFF in text contexts. If bytes 0xC4, 0xC5, 0xD6, 0xE4, 0xE5, 0xF6 appear → Latin-1
5. **#PROGRAM heuristic**: Extract program name from the file (readable in any encoding since it's typically ASCII):
   - Cloud software → assume UTF-8
   - Desktop software → assume CP437
6. **Fallback**: Latin-1 (every byte 0x00-0xFF is valid, never fails)

## Per-software encoding behaviors

| Software | Platform | Typical encoding | Notes |
|----------|----------|-----------------|-------|
| Fortnox | Cloud | UTF-8 | May declare `#FORMAT PC8`. Largest market share. |
| Visma Administration | Desktop | CP437 or Win-1252 | Legacy Windows app. Requires non-UTF-8 locale. |
| Visma eEkonomi | Cloud | UTF-8 or Latin-1 | Known garbage character issues in exports. |
| Visma Compact | Desktop | CP437 | Standards-compliant. Referenced in SIE spec examples. |
| BL Administration (Björn Lundén) | Desktop | CP437 | Standards-compliant. |
| Lundify (BL cloud) | Cloud | UTF-8 | Modern cloud version of BL. |
| SpeedLedger | Cloud | UTF-8 (likely) | Web-based Unicode environment. |
| PE Accounting | Cloud | UTF-8 (likely) | Web-based. |
| Bokio | Cloud | UTF-8 | Parser-level normalization documented. |
| Dooer | Cloud | UTF-8 | Parser-level normalization documented. |
| Hogia | Desktop/Cloud | CP437 or UTF-8 | Depends on product version. |

## #KSUMMA and encoding interaction

The CRC-32 checksum (#KSUMMA) is defined to operate on CP437 byte values. When a file is actually encoded in UTF-8:

1. Swedish characters have different byte representations (2 bytes in UTF-8 vs 1 byte in CP437)
2. The checksum computed on UTF-8 bytes will NOT match the expected CP437-based value
3. **Recommendation**: When non-CP437 encoding is detected, skip #KSUMMA validation entirely
4. When generating SIE files, write CP437 (the only encoding the spec allows) and, if used, a KSUMMA computed on the CP437 bytes. A UTF-8 file is not a valid SIE file even without KSUMMA; produce one only when the receiving program explicitly requires it

## Normalization strategy for import

Best practice for robust SIE import:

1. Read raw bytes from file
2. Detect encoding using the algorithm above
3. Decode to Unicode/UTF-8 internal representation
4. Validate #KSUMMA only if encoding is CP437
5. Parse all records from the Unicode text
6. Store internally as UTF-8
7. When exporting: write CP437 and transliterate characters CP437 lacks (e.g. `€`). Write UTF-8 only if the receiving program explicitly requires it, and omit KSUMMA in that case