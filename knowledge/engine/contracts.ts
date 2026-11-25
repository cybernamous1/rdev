// v0.5.0 layer contracts. Each layer of the discovery engine talks to the others ONLY through the types in this file,
// so a layer can be replaced, tested or disabled on its own. No layer imports another layer's internals.
//
//   L1 discovery   (engine/discovery)  : where to look next               -> Opportunity[]
//   L2 scanning    (engine/net)        : polite, bounded retrieval         -> FetchResult
//   L3 parsing     (engine/parse)      : bytes/text -> neutral page signals -> PageSignals
//   L4 knowledge   (engine/discovery/relevance + existing knowledge/*)     -> ResourceCandidate
//   L5 licensing   (engine/license)    : evidence + assessment (never clearance) -> LicenseEvidence[], LicenseAssessment
//   L6 monitoring  (engine/monitor)    : duplicates, change, recheck policy -> DuplicateVerdict, ChangeVerdict
//   L7 management  (worker/discovery-v5-*) : persistence + owner review (the only layer that writes the database)

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

// ---------- L1 discovery ----------
export type OpportunityKind = 'sitemap' | 'feed' | 'directory' | 'page' | 'repository';
export type DiscoveryMethod = 'owner-hint' | 'robots-sitemap' | 'sitemap' | 'feed' | 'link-analysis' | 'directory' | 'repository-api' | 'host-probe';
export type Opportunity = { url: string; kind: OpportunityKind; via: DiscoveryMethod; origin: string; depth: number; score: number; reason: string };

// ---------- L3 parsing ----------
export type PageLink = { url: string; text: string; rel: string[] };
export type PageSignals = {
  title: string; description: string; lang: string | null; canonical: string | null;
  robotsMeta: { noindex: boolean; nofollow: boolean };
  links: PageLink[]; feedLinks: string[]; licenseLinks: { url: string; text: string }[];
  metaLicense: { name: string; content: string }[]; jsonLd: unknown[]; copyrightMeta: string | null;
  proseText: string;        // visible text WITHOUT <pre>/<code> (so quoted licence texts in tutorials are not mistaken for the page's own licence)
  codeText: string;         // text of <pre>/<code> blocks (bounded)
  footerText: string;       // visible text near the end of the document (where notices usually live)
  codeBlocks: number; headings: number; textLength: number;
};

// ---------- L4 knowledge classification ----------
export type ResourceType = 'documentation' | 'tutorial' | 'course' | 'reference' | 'article' | 'repository' | 'directory' | 'unknown';
export type LanguageGuess = { code: 'en' | 'other' | 'unknown'; confidence: number; basis: string };
export type PathClassifier = (text: string, title: string) => { path: string | null; score: number };
export type ResourceCandidate = {
  url: string; canonicalUrl: string; title: string; host: string; publisher: string;
  resourceType: ResourceType; language: LanguageGuess; relevance: number; suggestedPath: string | null;
  signals: string[]; via: DiscoveryMethod; depth: number; contentHash: string; simhash: string;
};

// ---------- L5 licensing ----------
export type LicenseKind = 'open-source' | 'creative-commons' | 'public-domain' | 'custom-permission' | 'proprietary' | 'copyright-notice' | 'terms-reference' | 'unknown';
export type LicenseScope = 'page' | 'site' | 'code' | 'content' | 'repository' | 'unspecified';
export type Restriction = 'attribution' | 'non-commercial' | 'no-derivatives' | 'share-alike' | 'copyleft' | 'weak-copyleft' | 'no-redistribution' | 'no-reproduction'
  | 'permission-required' | 'patent-clause' | 'personal-use-only' | 'educational-use-only' | 'notice-required' | 'unspecified-conditions';
export type DetectionMethod = 'rel-license' | 'meta-tag' | 'json-ld' | 'spdx-tag' | 'cc-url' | 'text-pattern' | 'copyright-notice' | 'github-api' | 'terms-link';
export type LicenseEvidence = {
  kind: LicenseKind; identifier: string | null; label: string;
  evidenceUrl: string;                // the page the evidence was found on (exact URL)
  licenseUrl: string | null;          // the document the evidence points at, if any
  excerpt: string;                    // original text, verbatim, bounded (never a transformation)
  method: DetectionMethod; scope: LicenseScope; confidence: number;
  restrictions: Restriction[];
  indicates: 'permissive' | 'conditional' | 'restricted' | 'unknown';   // what THIS EVIDENCE says. It is not a clearance.
  detectedAt: string; contentHash: string | null; notes: string[];
};
export type ReuseStatus = 'no-evidence' | 'indicated-permissive' | 'indicated-conditional' | 'restricted' | 'conflicting' | 'ambiguous';
export type LicenseAssessment = {
  access: { publiclyReadable: boolean; note: string };
  reuse: { status: ReuseStatus; summary: string };
  restrictions: Restriction[]; confidence: number; conflicts: string[]; reasons: string[];
  clearance: 'not-cleared';           // the engine can only ever say this; clearance is an owner decision (license_reviews)
  requiresOwnerDecision: true;
};

// ---------- L6 monitoring ----------
export type DuplicateVerdict = { exact: boolean; near: { id: number; distance: number }[] };
export type ChangeState = 'new' | 'unchanged' | 'minor-change' | 'major-change' | 'moved' | 'gone' | 'unreachable';
export type ChangeVerdict = { state: ChangeState; reason: string };

// ---------- runtime registry ----------
export type Operation = 'html.signals' | 'sitemap.parse' | 'feed.parse' | 'license.detect' | 'text.simhash' | 'text.language';
