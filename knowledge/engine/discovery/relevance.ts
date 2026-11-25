// L4 knowledge classification for DISCOVERY: is this page an English-language educational / programming resource, and of what kind?
// Transparent keyword and structure rules, not an AI model. Every point of the score is returned as a human-readable signal,
// so the Owner Console can explain exactly why a candidate was suggested. Learning-path matching is injected (PathClassifier)
// so this layer does not import the learning-path catalogue.
import type { LanguageGuess, PageSignals, PathClassifier, ResourceType } from '../contracts.ts';

const EN_WORDS = new Set('the of and to in is that for it as with are this on be by or from at an your you can will not have which has if one use used using when how what these more all other than into but they their its also such each only'.split(' '));
const COMMON_OTHER = /[\u0400-\u04ff\u0600-\u06ff\u0900-\u097f\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af\u0e00-\u0e7f]/;

export function guessLanguage(text: string, declared: string | null): LanguageGuess {
  const words = text.toLowerCase().match(/[a-z']+/g) || [];
  const sample = words.slice(0, 600); const hits = sample.filter((w) => EN_WORDS.has(w)).length; const ratio = sample.length ? hits / sample.length : 0;
  const scripts = (text.slice(0, 2000).match(COMMON_OTHER) || []).length / Math.max(1, Math.min(text.length, 2000));
  const d = (declared || '').toLowerCase();
  if (scripts > 0.2) return { code: 'other', confidence: 0.9, basis: 'mostly non-Latin script' };
  if (sample.length >= 40) {
    if (ratio >= 0.2) return { code: 'en', confidence: d.startsWith('en') ? 0.95 : 0.8, basis: `English function words ${(ratio * 100).toFixed(0)}%${d ? `, lang="${d}"` : ''}` };
    if (ratio < 0.08) return { code: 'other', confidence: d && !d.startsWith('en') ? 0.9 : 0.7, basis: `few English function words (${(ratio * 100).toFixed(0)}%)${d ? `, lang="${d}"` : ''}` };
  }
  if (d.startsWith('en')) return { code: 'en', confidence: 0.6, basis: `lang="${d}" (too little text to verify)` };
  if (d) return { code: 'other', confidence: 0.6, basis: `lang="${d}"` };
  return { code: 'unknown', confidence: 0.3, basis: 'too little text to decide' };
}

const EDU = /\b(tutorial|guide|learn|learning|lesson|course|curriculum|handbook|cookbook|getting[- ]started|how[- ]to|examples?|walkthrough|introduction|beginner|reference|documentation|docs|api)\b/gi;
const PROG = /\b(function|variable|class|method|syntax|compile[rd]?|runtime|script(?:ing)?|library|framework|algorithm|code|programming|developer|debug|module|parameter|interface|type|array|loop|repository)\b/gi;
const SHOPPING = /\b(buy now|add to cart|pricing plans|subscribe now|sign up for free|limited offer|coupon)\b/i;

export function guessResourceType(url: URL, s: Pick<PageSignals, 'title' | 'links' | 'textLength' | 'codeBlocks'>): ResourceType {
  const p = (url.pathname + ' ' + s.title).toLowerCase();
  if (url.hostname === 'github.com' && url.pathname.split('/').filter(Boolean).length === 2) return 'repository';
  if (/\b(course|courses|lesson|lessons|curriculum|class)\b/.test(p)) return 'course';
  if (/\b(tutorial|tutorials|guide|guides|how-to|howto|getting-started|walkthrough|learn)\b/.test(p)) return 'tutorial';
  if (/\b(reference|api|apis|spec|manual)\b/.test(p)) return 'reference';
  if (/\b(docs?|documentation|handbook)\b/.test(p)) return 'documentation';
  if (s.links.length > 40 && s.textLength / Math.max(1, s.links.length) < 120) return 'directory';
  if (/\b(blog|article|post|news)\b/.test(p)) return 'article';
  return 'unknown';
}

export type Relevance = { score: number; signals: string[]; suggestedPath: string | null; resourceType: ResourceType; language: LanguageGuess };

/** Score 0..~14. Candidates need >= MIN_RELEVANCE and an English (or undecided) language to be queued. */
export const MIN_RELEVANCE = 4;
export function assessRelevance(url: URL, s: PageSignals, classify: PathClassifier): Relevance {
  const signals: string[] = []; let score = 0;
  const hay = decodeURIComponent(url.pathname).replace(/[-_/]+/g, ' ') + ' ' + s.title + ' ' + s.description;
  const edu = new Set((hay.match(EDU) || []).map((x) => x.toLowerCase())); if (edu.size) { const n = Math.min(3, edu.size); score += n; signals.push(`educational wording in title/URL (${[...edu].slice(0, 3).join(', ')})`); }
  const body = s.proseText.slice(0, 20_000);
  const prog = new Set((body.match(PROG) || []).map((x) => x.toLowerCase())); if (prog.size >= 3) { const n = Math.min(3, Math.floor(prog.size / 3)); score += n; signals.push(`programming vocabulary (${prog.size} distinct terms)`); }
  if (s.codeBlocks > 0) { score += Math.min(2, s.codeBlocks); signals.push(`${s.codeBlocks} code block(s)`); }
  if (s.headings >= 3 && s.textLength > 1500) { score += 1; signals.push('structured long-form text'); }
  const path = classify(body + ' ' + hay, s.title); if (path.path && path.score > 0) { score += Math.min(3, Math.ceil(path.score / 4)); signals.push(`matches learning path "${path.path}"`); }
  if (SHOPPING.test(body.slice(0, 5000))) { score -= 3; signals.push('commercial/shopping wording (penalty)'); }
  if (s.textLength < 400 && s.codeBlocks === 0) { score -= 2; signals.push('very little text (penalty)'); }
  const language = guessLanguage(body, s.lang);
  return { score: Math.max(0, score), signals, suggestedPath: path.path, resourceType: guessResourceType(url, s), language };
}

/** Cheap pre-fetch score from a URL and optional title only (used to order the frontier, never to queue a candidate). */
export function scoreUrl(url: URL, text = ''): { score: number; reason: string } {
  const hay = (decodeURIComponent(url.pathname).replace(/[-_/.]+/g, ' ') + ' ' + text).toLowerCase();
  const edu = new Set(hay.match(EDU) || []); const prog = new Set(hay.match(PROG) || []);
  let score = Math.min(4, edu.size * 2) + Math.min(2, prog.size);
  if (/\.(png|jpe?g|gif|svg|webp|ico|css|js|zip|gz|mp4|webm|woff2?|ttf|pdf)$/i.test(url.pathname)) score = -10;
  if (/\/(login|signin|signup|cart|checkout|account|search|tag|category|author|feed|wp-json|cdn-cgi)\b/i.test(url.pathname)) score -= 4;
  return { score, reason: score > 0 ? `URL/title wording: ${[...edu, ...prog].slice(0, 4).join(', ')}` : 'no educational wording in URL' };
}
