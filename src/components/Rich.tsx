import type { ReactNode } from 'react';
import type { Block } from '../types.ts';
import { Icon } from './Icon.tsx';

/** Inline `code` and **bold** only. Text is never injected as HTML. */
export function Rich({ text }: { text: string }) {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*)/g;
  let last = 0; let m: RegExpExecArray | null; let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith('`')) out.push(<code key={k++} className="inline-code">{t.slice(1, -1)}</code>);
    else if (t.startsWith('**')) out.push(<strong key={k++}>{t.slice(2, -2)}</strong>);
    else out.push(<em key={k++}>{t.slice(1, -1)}</em>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}

const KEYWORDS = new Set(['and', 'break', 'continue', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'if', 'in', 'local', 'nil', 'not', 'or', 'repeat', 'return', 'then', 'true', 'until', 'while', 'export', 'type']);
export function highlightLuau(code: string): ReactNode[] {
  const re = /(--\[(=*)\[[\s\S]*?\]\2\]|--[^\n]*)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\\n])*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z_0-9]*)/g;
  const out: ReactNode[] = []; let last = 0; let m: RegExpExecArray | null; let k = 0;
  while ((m = re.exec(code))) {
    if (m.index > last) out.push(code.slice(last, m.index));
    if (m[1]) out.push(<span key={k++} className="tk-c">{m[0]}</span>);
    else if (m[3]) out.push(<span key={k++} className="tk-s">{m[0]}</span>);
    else if (m[4]) out.push(<span key={k++} className="tk-n">{m[0]}</span>);
    else if (m[5] && KEYWORDS.has(m[5])) out.push(<span key={k++} className="tk-k">{m[0]}</span>);
    else if (m[5] && /^[A-Z]/.test(m[5])) out.push(<span key={k++} className="tk-t">{m[0]}</span>);
    else out.push(m[0]);
    last = m.index + m[0].length;
  }
  if (last < code.length) out.push(code.slice(last));
  return out;
}

export function CodeBlock({ lang, code, onCopy, onOpen }: { lang: string; code: string; onCopy: (c: string) => void; onOpen?: (c: string) => void }) {
  return (
    <div className="code-box">
      <div className="code-head">
        <span>{lang === 'luau' ? 'Luau' : lang}</span>
        <span className="code-actions">
          {lang === 'luau' && onOpen && <button onClick={() => onOpen(code)}><Icon name="code" size={14} /> Open in Playground</button>}
          <button onClick={() => onCopy(code)}><Icon name="copy" size={14} /> Copy</button>
        </span>
      </div>
      <pre tabIndex={0}><code>{lang === 'luau' ? highlightLuau(code) : code}</code></pre>
    </div>
  );
}

export const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function Blocks({ blocks, onCopy, onOpen }: { blocks: Block[]; onCopy: (c: string) => void; onOpen?: (c: string) => void }) {
  return (
    <>
      {blocks.map((b, i) => {
        switch (b.type) {
          case 'h': return b.level === 2 ? <h2 id={slugify(b.text)} key={i}>{b.text}</h2> : <h3 id={slugify(b.text)} key={i}>{b.text}</h3>;
          case 'p': return <p key={i}><Rich text={b.text} /></p>;
          case 'code': return <CodeBlock key={i} lang={b.lang} code={b.code} onCopy={onCopy} onOpen={onOpen} />;
          case 'list': return b.ordered ? <ol key={i}>{b.items.map((t, j) => <li key={j}><Rich text={t} /></li>)}</ol> : <ul key={i}>{b.items.map((t, j) => <li key={j}><Rich text={t} /></li>)}</ul>;
          case 'callout': return <aside key={i} className={`callout callout-${b.tone}`}><Icon name={b.tone === 'warning' ? 'alert' : b.tone === 'tip' ? 'sparkles' : 'info'} size={17} /><p><Rich text={b.text} /></p></aside>;
          case 'exercise': return <section key={i} className="exercise-box"><span className="eyebrow">TRY IT YOURSELF</span><h3>Practice exercise</h3><p><Rich text={b.text} /></p></section>;
        }
      })}
    </>
  );
}
