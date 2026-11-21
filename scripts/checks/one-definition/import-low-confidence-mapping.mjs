export default {
  rule: 'import-low-confidence-mapping',
  says: 'An account mapping counts as uncertain ("osäker") by one threshold, wherever the import counts, filters or stops for it.',
  home: 'src/lib/import/account-mapper.ts: isLowConfidenceMapping',
  why: 'The mapping step counted below 0.7 and the import statistics below 0.5, so the preview said no uncertain mappings where the mapping step said one (#2539).',
  // detected_columns is the opening balance wizard grading its own column
  // detection, not an account mapping.
  match: [/(?<!detected_columns)\.confidence\s*<\s*0?\.\d/],
  sanctioned: ['lib/import/account-mapper.ts'],
  scan: ['lib/import/', 'components/import/', 'app/(dashboard)/import/', 'app/api/import/', 'extensions/general/arcim-migration/'],
}
