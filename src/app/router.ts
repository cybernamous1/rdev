import { useEffect, useState } from 'react';

export type Route = { segments: string[]; params: URLSearchParams; raw: string };

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, '') || '/home';
  const [pathPart, query = ''] = raw.split('?');
  return { segments: pathPart.split('/').filter(Boolean).map(decodeURIComponent), params: new URLSearchParams(query), raw };
}
export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(location.hash));
  useEffect(() => {
    const on = () => { setRoute(parseHash(location.hash)); };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}
export const href = (path: string, params?: Record<string, string | undefined>) => {
  const q = new URLSearchParams(); for (const [k, v] of Object.entries(params || {})) if (v) q.set(k, v);
  const s = q.toString();
  return '#' + path + (s ? '?' + s : '');
};
export const navigate = (path: string, params?: Record<string, string | undefined>) => { location.hash = href(path, params).slice(1); };
export const replace = (path: string, params?: Record<string, string | undefined>) => { history.replaceState(null, '', href(path, params)); window.dispatchEvent(new HashChangeEvent('hashchange')); };
