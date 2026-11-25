// robots.txt (RFC 9309) parser and matcher. Pure; no network. The product token is `rdevacademybot`.
export const ROBOTS_TOKEN = 'rdevacademybot';
export type RobotsPolicy = { allows(pathAndQuery: string): boolean; crawlDelaySec: number | null; sitemaps: string[]; mode: 'rules' | 'allow-all' | 'disallow-all' };

const toRegex = (pattern: string) => {
  const anchored = pattern.endsWith('$'); const body = anchored ? pattern.slice(0, -1) : pattern;
  return new RegExp('^' + body.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + (anchored ? '$' : ''));
};

export const ALLOW_ALL: RobotsPolicy = { allows: () => true, crawlDelaySec: null, sitemaps: [], mode: 'allow-all' };
export const DISALLOW_ALL: RobotsPolicy = { allows: () => false, crawlDelaySec: null, sitemaps: [], mode: 'disallow-all' };

export function parseRobots(text: string, token = ROBOTS_TOKEN): RobotsPolicy {
  const lines = text.slice(0, 512 * 1024).split(/\r?\n/);
  type Group = { agents: string[]; rules: { allow: boolean; pattern: string }[]; delay: number | null };
  const groups: Group[] = []; const sitemaps: string[] = []; let cur: Group | null = null; let lastWasAgent = false;
  for (const raw of lines) {
    const line = raw.replace(/#.*/, '').trim(); if (!line) continue;
    const i = line.indexOf(':'); if (i < 0) continue;
    const field = line.slice(0, i).trim().toLowerCase(); const value = line.slice(i + 1).trim();
    if (field === 'user-agent') { if (!cur || !lastWasAgent) { cur = { agents: [], rules: [], delay: null }; groups.push(cur); } cur.agents.push(value.toLowerCase()); lastWasAgent = true; continue; }
    lastWasAgent = false;
    if (field === 'sitemap') { if (/^https:\/\//i.test(value) && sitemaps.length < 20) sitemaps.push(value); continue; }
    if (!cur) continue;
    if (field === 'allow' || field === 'disallow') cur.rules.push({ allow: field === 'allow', pattern: value });
    else if (field === 'crawl-delay') { const n = Number(value); if (Number.isFinite(n) && n >= 0) cur.delay = Math.min(n, 3600); }
  }
  const mine = groups.filter((g) => g.agents.some((a) => a !== '*' && token.includes(a)));
  const chosen = mine.length ? mine : groups.filter((g) => g.agents.includes('*'));
  // An empty "Disallow:" means "allow everything"; it carries no pattern to match.
  const rules = chosen.flatMap((g) => g.rules).filter((r) => r.pattern !== '').map((r) => ({ allow: r.allow, re: toRegex(r.pattern), len: r.pattern.length }));
  const delay = chosen.map((g) => g.delay).find((d) => d !== null) ?? null;
  return {
    mode: 'rules', crawlDelaySec: delay, sitemaps,
    allows(p: string) {
      let best: { allow: boolean; len: number } | null = null;
      for (const r of rules) if (r.re.test(p) && (!best || r.len > best.len || (r.len === best.len && r.allow))) best = { allow: r.allow, len: r.len };
      return best ? best.allow : true;
    }
  };
}

/** HTTP outcome of fetching /robots.txt -> policy. Unavailable (5xx / network / 401 / 403) is treated as "do not crawl" to stay conservative. */
export function robotsFromResponse(status: number | null, body: string): RobotsPolicy {
  if (status === null) return DISALLOW_ALL;
  if (status === 404 || status === 410) return ALLOW_ALL;
  if (status >= 200 && status < 300) return parseRobots(body);
  return DISALLOW_ALL;
}
