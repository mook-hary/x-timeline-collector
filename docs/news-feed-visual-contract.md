# News Feed Vision / Visual extension (schemaVersion 1)

The Daily Enriched exporter adds fields without renaming or removing existing
fields. Consumers that ignore unknown fields remain compatible. Media conversion,
Daily Enriched input selection, sort-only ranking, scores, titles and summaries
are unchanged. No AI evaluation or media fetching occurs during export.

`vision` is optional. Only `status: "ok"` with nonempty string observations is
exported; absent/skipped/failed or malformed observations omit the object. The
only keys are `status`, `observations`, and `visibleText` (string or null; invalid
visibleText becomes null). Successful semantic text is copied, not rewritten.
Uncertainties, model/version/timing metadata, media identities, diagnostics and
cache details are never copied. Observations and visible text are intentionally
public; this projection does not redact text inside those approved semantic fields.

`visual` is always present, including legacy rows:

```json
{
  "vision": {
    "status": "ok",
    "observations": "A reference diagram.",
    "visibleText": null
  },
  "visual": {
    "value": 4,
    "roles": ["reference", "diagram"]
  }
}
```

Value is null or an integer from 1 through 5. Roles use the existing allowlist:
evidence, reference, diagram, artwork, screenshot, photo, production-material,
other. Validation is reused without invoking the evaluator. Duplicate roles are
removed in canonical allowlist order; other cannot accompany another role.
Absent/invalid value or roles reset the entire object to `{"value":null,"roles":[]}`.
Additional internal visual keys are discarded before validation. Visual export
reflects stored data and does not require Vision to be present in legacy input.

Analyze, Vision, Visual Value, AI Analyze and Enrich already preserve the required
post fields through Daily Enriched. No preservation or scoring changes are needed.
The public feed keeps all Daily Enriched rows, including rows without either field.
Generated feeds and downstream Timeline Digest behavior are outside this change.
