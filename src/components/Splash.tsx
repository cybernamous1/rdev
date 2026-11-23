import { useCallback, useEffect, useRef, useState } from 'react';
import { initialize, CriticalInitError, type InitResult, type Progress } from '../services/initialize.ts';
import { Logo } from './Logo.tsx';
import { Icon } from './Icon.tsx';

const MIN_BRAND_MS = 1600; // lets the logo animation finish; the progress bar itself always shows real progress
const TIPS = [
  'Small, finished projects teach more than big unfinished ones.',
  'Read the first red line in Output first; later errors are often side effects.',
  'The server decides. The client asks.',
  'Set a Part’s Parent last, after its properties are configured.',
  'Your progress stays in this browser. No account needed.'
];

type Phase = { kind: 'loading' } | { kind: 'notices'; result: InitResult } | { kind: 'error'; message: string; details: string[] };

export function Splash({ onReady }: { onReady: (r: InitResult) => void }) {
  const [progress, setProgress] = useState<Progress>({ value: 0, message: 'Starting…', stages: [], notices: [] });
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [tip] = useState(() => TIPS[Math.floor(Math.random() * TIPS.length)]);
  const runId = useRef(0);

  const run = useCallback(async () => {
    const id = ++runId.current; const started = performance.now();
    setPhase({ kind: 'loading' });
    try {
      const result = await initialize((p) => { if (id === runId.current) setProgress(p); });
      const wait = Math.max(0, MIN_BRAND_MS - (performance.now() - started));
      await new Promise((r) => setTimeout(r, wait));
      if (id !== runId.current) return;
      if (result.notices.length) setPhase({ kind: 'notices', result }); else onReady(result);
    } catch (err) {
      if (id !== runId.current) return;
      const e = err as Error;
      setPhase({ kind: 'error', message: e.message || 'Startup failed.', details: err instanceof CriticalInitError ? err.details : [String(e.stack || e)] });
    }
  }, [onReady]);

  useEffect(() => { run(); }, [run]);

  const pct = Math.round(progress.value * 100);
  const failed = phase.kind === 'error';
  return (
    <div className="splash" role="status" aria-live="polite">
      <div className="splash-glow" />
      <div className="splash-inner">
        <Logo size={118} animated />
        <h1 className="splash-word">RDev <span>Academy</span></h1>
        <p className="splash-tag">Create. Learn. Develop.</p>

        {phase.kind === 'loading' && (
          <>
            <div className="splash-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Initialization progress"><i style={{ width: pct + '%' }} /></div>
            <div className="splash-line"><span className="splash-msg">{progress.message}</span><b>{pct}%</b></div>
            <ul className="splash-stages">
              {progress.stages.map((s) => (
                <li key={s.id} className={`st-${s.status}`}>
                  <span className="st-dot">{s.status === 'done' ? <Icon name="check" size={11} /> : s.status === 'warn' || s.status === 'error' ? '!' : s.status === 'skipped' ? '–' : ''}</span>{s.label}
                </li>
              ))}
            </ul>
            <p className="splash-tip">{tip}</p>
          </>
        )}

        {phase.kind === 'notices' && (
          <div className="splash-panel">
            <h2><Icon name="info" size={18} /> Ready, with a few notes</h2>
            <p>Learning works normally. These things are limited right now:</p>
            <ul>{phase.result.notices.map((n, i) => <li key={i}>{n}</li>)}</ul>
            <button className="primary-btn" onClick={() => onReady(phase.result)}>Continue <Icon name="chevR" size={16} /></button>
          </div>
        )}

        {failed && (
          <div className="splash-panel splash-error">
            <h2><Icon name="alert" size={18} /> RDev Academy could not start</h2>
            <p>{phase.message}</p>
            {phase.details.length > 0 && <details><summary>Technical details</summary><ul>{phase.details.map((d, i) => <li key={i}>{d}</li>)}</ul></details>}
            <p className="muted">Your saved progress has not been changed. Try again, and if the problem continues, reload the page or update your browser.</p>
            <button className="primary-btn" onClick={run}><Icon name="refresh" size={16} /> Try again</button>
          </div>
        )}
      </div>
    </div>
  );
}
