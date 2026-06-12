# Patterns

Spec-authoring guide. Lessons learned from completed specs about what makes agents produce good output. Read this when writing new specs.

## Name the fallback for unproducible artifacts

If an acceptance criterion requires an artifact the executing agent may not be able to produce (screenshots, recordings, device captures), say so in the criterion and name the fallback — e.g. "or verified live, with the check noted in outcome/FEEDBACK.md." Otherwise completion is ambiguous and the score gets docked for tooling, not work. *(from throughline/color-system, 2026-06-12)*
