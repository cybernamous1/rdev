# Licensing intelligence (v0.5.0)

Principle: **free access is not permission to reuse.** The engine records evidence and an assessment. Only the owner can record a clearance, in a separate append-only decision.

## Evidence

`license_evidence` (append-only; one row per distinct detection, idempotent on rescan) keeps: the **exact evidence URL**, the licence document URL if any, a **verbatim excerpt** (never reworded), method (`rel-license`, `meta-tag`, `json-ld`, `spdx-tag`, `cc-url`, `text-pattern`, `copyright-notice`, `github-api`, `terms-link`), **scope** (`page`, `site`, `code`, `content`, `repository`, `unspecified`), **confidence**, **restrictions**, what the evidence *indicates* (`permissive`/`conditional`/`restricted`/`unknown`), detector version, content hash and detection timestamp.

Recognised without a closed list: SPDX identifiers and expressions (`OR`, `AND`, `WITH`, `/`) including unknown identifiers (kept as `unknown`, never permissive); Creative Commons URLs and names with elements/version/jurisdiction; CC0/PDM and public-domain declarations; custom permission statements; proprietary wording ("may not be reproduced", "all rights reserved", personal-use-only); copyright notices; terms/legal links (flagged as unread); dual licensing; GitHub repository licences (scope `repository`, with the caveat that code licences may not cover prose). Licence text quoted inside `<pre>/<code>` is ignored.

## Assessment

`assessLicense` returns `no-evidence`, `indicated-permissive`, `indicated-conditional`, `restricted`, `conflicting` or `ambiguous`, with restrictions, confidence, conflicts and reasons. Always `clearance: "not-cleared"` and `requiresOwnerDecision: true`. Rules: a restriction beside open evidence is `conflicting`; different licences over overlapping scope are `conflicting` (code-vs-text splits are not); repository/code-only evidence is `ambiguous` for documentation; low confidence or unrecognised terms are `ambiguous`; `OR` licences are a recorded choice; unread terms pages are noted.

## Owner clearance

`license_reviews` (append-only; the newest row is current): decision (`cleared`, `cleared-with-conditions`, `denied`), basis (`detected-evidence`, `owner-written-permission`, `owner-judgement`), scope, permissions (display/modification/redistribution/commercial), attribution, conditions, cited evidence ids, the assessment status at the time, written reason. **Database triggers** enforce: evidence-based clearance must cite evidence recorded for that candidate; ambiguous/conflicting/restricted/no-evidence cannot be cleared without an explicit acknowledgement; conditional clearance needs written conditions; no edits or deletes.

This is separate from approving a source (existing review) and from approving a proposal. In v0.5.0 clearance is **recorded and shown**, including on proposals, but does not block publication: adding a hard publication gate would change v0.4.0 approval behaviour for existing content and needs an owner decision.

Limits: detection is wording-based, not legal advice; jurisdiction-specific public-domain status, multi-party rights and terms pages are not interpreted.
