import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { lintLuau } from '../../shared/luau.ts';
import { useApp } from '../app/context.tsx';
import { useActions, useNotify } from '../app/helpers.tsx';
import { Icon } from '../components/Icon.tsx';
import { STARTER_CODE } from '../services/localData.ts';
import { downloadText } from '../services/packages.ts';

export function Playground() {
  const { state, update, lib } = useApp();
  const { copy } = useActions();
  const notify = useNotify();
  const code = state.playgroundCode;
  const gutter = useRef<HTMLDivElement>(null);
  const [name, setName] = useState('');
  const setCode = (c: string) => update((s) => ({ ...s, playgroundCode: c }));
  const findings = useMemo(() => lintLuau(code), [code]);
  const lineCount = code.split('\n').length;
  const examples = useMemo(() => lib.entries.filter((e) => e.kind === 'lesson').flatMap((e) => e.blocks.map((b, i) => ({ b, i, e })).filter((x) => x.b.type === 'code' && x.b.lang === 'luau').map((x) => ({ key: `${x.e.id}#${x.i}`, label: `${x.e.title}${x.e.blocks.filter((y) => y.type === 'code' && y.lang === 'luau').length > 1 ? ` (example ${x.e.blocks.slice(0, x.i).filter((y) => y.type === 'code' && y.lang === 'luau').length + 1})` : ''}`, code: x.b.type === 'code' ? x.b.code : '' }))), [lib]);
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Tab') return;
    e.preventDefault();
    const t = e.currentTarget; const { selectionStart: a, selectionEnd: b } = t;
    setCode(code.slice(0, a) + '    ' + code.slice(b));
    requestAnimationFrame(() => { t.selectionStart = t.selectionEnd = a + 4; });
  };
  const saveSnippet = () => {
    const n = name.trim() || `Snippet ${state.snippets.length + 1}`;
    if (state.snippets.length >= 30) return notify('You can keep up to 30 snippets. Delete one first.');
    update((s) => ({ ...s, snippets: [{ id: crypto.randomUUID?.() ?? String(Date.now()), name: n, code, updatedAt: new Date().toISOString() }, ...s.snippets] }));
    setName(''); notify('Snippet saved in this browser');
  };
  const errors = findings.filter((f) => f.severity === 'error').length;
  return (
    <>
      <div className="page-heading"><span className="eyebrow">PRACTICE SPACE</span><h1>Code Playground</h1><p>Write and edit Luau, load examples from lessons and get structural hints. This is a text editor: it does <b>not</b> run Luau or emulate Roblox Studio. Use Studio to run code.</p></div>
      <div className="playground">
        <div className="play-head">
          <div><span className="live-dot" /> <b>Luau editor</b><small>{lineCount} lines · {code.length} characters · saved automatically in this browser</small></div>
          <div className="play-tools">
            <button className="tool-btn" onClick={() => setCode(STARTER_CODE)}><Icon name="reset" size={15} /> Reset</button>
            <button className="tool-btn" onClick={() => copy(code)}><Icon name="copy" size={15} /> Copy</button>
            <button className="tool-btn" onClick={() => downloadText('snippet.luau', code, 'text/plain')}><Icon name="download" size={15} /> .luau</button>
          </div>
        </div>
        <div className="editor">
          <div className="gutter" ref={gutter} aria-hidden="true">{Array.from({ length: lineCount }, (_, i) => <div key={i} className={findings.some((f) => f.line === i + 1 && f.severity === 'error') ? 'gl-err' : findings.some((f) => f.line === i + 1) ? 'gl-warn' : ''}>{i + 1}</div>)}</div>
          <textarea spellCheck={false} autoCapitalize="off" autoCorrect="off" aria-label="Luau code editor" value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={onKey} onScroll={(e) => { if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop; }} wrap="off" />
        </div>
        <div className="play-foot"><span>{errors ? `${errors} structural problem${errors === 1 ? '' : 's'}` : findings.length ? `${findings.length} hint${findings.length === 1 ? '' : 's'}` : 'No structural problems or deprecated patterns found'}</span><span>Heuristic checks only, not a Luau compiler</span></div>
      </div>

      {findings.length > 0 && <ul className="findings" aria-label="Code hints">{findings.map((f, i) => <li key={i} className={`f-${f.severity}`}><Icon name={f.severity === 'error' ? 'alert' : 'info'} size={15} /><span><b>Line {f.line}</b> · {f.message}</span></li>)}</ul>}

      <div className="two-col">
        <section className="panel"><h2>Load an example</h2><p className="muted">Code from the lessons in your library.</p>
          {examples.length === 0 ? <p className="muted small">Lesson examples will appear here once lessons have been published.</p> : <select aria-label="Load example from a lesson" value="" onChange={(e) => { const ex = examples.find((x) => x.key === e.target.value); if (ex) { setCode(ex.code); notify('Example loaded'); } }}>
            <option value="">Choose an example…</option>{examples.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
          </select>}
        </section>
        <section className="panel"><h2>My snippets</h2><p className="muted">Stored only in this browser.</p>
          <div className="inline-form"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Snippet name" aria-label="Snippet name" maxLength={60} /><button className="primary-btn small" onClick={saveSnippet}><Icon name="save" size={15} /> Save</button></div>
          {state.snippets.length === 0 ? <p className="muted small">No saved snippets yet.</p> : (
            <ul className="snippet-list">{state.snippets.map((s) => <li key={s.id}><button onClick={() => { setCode(s.code); notify(`Loaded “${s.name}”`); }}>{s.name}</button><button className="icon-btn" aria-label={`Delete ${s.name}`} onClick={() => update((st) => ({ ...st, snippets: st.snippets.filter((x) => x.id !== s.id) }))}><Icon name="trash" size={16} /></button></li>)}</ul>
          )}
        </section>
      </div>
    </>
  );
}
