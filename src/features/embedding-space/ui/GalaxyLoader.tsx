/**
 * Embedding Space loader — "charting the galaxy" (v1.0.74 redesign).
 *
 * One honest overall percentage (weighted by how long each stage really takes, with
 * progress inside a stage when the build can measure it), plain-language copy instead of
 * pipeline jargon, and text that wraps instead of running off the card.
 */
import { useEffect, useState } from 'react';
import type { LoadingStep } from './state';

/** Stage weights: vector reading dominates; the render step covers model load + warm-up. */
const STAGE_WEIGHTS = [0.42, 0.2, 0.13, 0.1, 0.15];
/** A running stage that can't measure itself still shows some motion. */
const RUNNING_FLOOR = 0.08;

const STAGE_COPY: Record<string, { title: string; running: (detail?: string) => string }> = {
  'Loading all embedding vectors': {
    title: 'Reading your games',
    running: (d) => (d && /^[\d,]+$/.test(d) ? `Gathering what makes each game unique — ${d} so far` : 'Gathering what makes each game unique'),
  },
  'Loading game metadata': { title: 'Matching details', running: () => 'Matching titles, genres and studios' },
  'Projecting to 3D (PCA)': { title: 'Charting the galaxy', running: () => 'Working out which games belong near each other' },
  'Building galaxy map': { title: 'Placing stars', running: () => 'Placing every game as a star' },
  'Rendering galaxy': { title: 'Lighting up', running: () => 'Lighting up the cosmos' },
};

const TIPS = [
  'Similar games drift together — the closer two stars, the more alike they are.',
  'Scroll to fly closer. Pick any star to see its nearest neighbours.',
  'The Path traces every game you’ve played, in the order you first played it.',
  'Press L to lasso a region and see which genres live there.',
  'Search any game and Ark will fly you straight to it.',
];

/** Weighted overall progress 0–100 (pure — unit tested). */
export function loaderProgress(steps: LoadingStep[]): number {
  if (steps.length === 0) return 0;
  const weights = steps.map((_, i) => STAGE_WEIGHTS[i] ?? STAGE_WEIGHTS[STAGE_WEIGHTS.length - 1]);
  const total = weights.reduce((a, b) => a + b, 0);
  let acc = 0;
  steps.forEach((s, i) => {
    const f = s.status === 'done' ? 1 : s.status === 'running' ? Math.max(RUNNING_FLOOR, Math.min(1, s.fraction ?? 0)) : 0;
    acc += weights[i] * f;
  });
  return Math.min(100, Math.round((acc / total) * 100));
}

/** Plain-language line for the active stage (pure — unit tested). */
export function loaderMessage(steps: LoadingStep[]): string {
  const waiting = steps.find((s) => s.status === 'waiting');
  if (waiting) return 'Your games are still being analysed — the galaxy will open as soon as that finishes.';
  const active = steps.find((s) => s.status === 'running');
  if (!active) return steps.length > 0 && steps.every((s) => s.status === 'done') ? 'Almost there…' : 'Getting ready…';
  return STAGE_COPY[active.base]?.running(active.detail) ?? 'Getting ready…';
}

const R = 46;
const C = 2 * Math.PI * R;

export function GalaxyLoader({ steps }: { steps: LoadingStep[] }) {
  const pct = loaderProgress(steps);
  const message = loaderMessage(steps);
  const [tip, setTip] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTip((i) => (i + 1) % TIPS.length), 5200);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="es-loader" role="status" aria-live="polite" aria-label={`Opening Embedding Space, ${pct}%`}>
      <div className="es-loader-card">
        <div className="es-loader-orbit" aria-hidden>
          <svg width="120" height="120" viewBox="0 0 120 120">
            <defs>
              <linearGradient id="es-loader-arc" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="#22d3ee" />
                <stop offset="55%" stopColor="#a855f7" />
                <stop offset="100%" stopColor="#e879f9" />
              </linearGradient>
              <radialGradient id="es-loader-core">
                <stop offset="0%" stopColor="rgba(232,121,249,0.35)" />
                <stop offset="100%" stopColor="rgba(232,121,249,0)" />
              </radialGradient>
            </defs>
            <circle cx="60" cy="60" r="34" fill="url(#es-loader-core)" />
            <circle cx="60" cy="60" r={R} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="3" />
            <circle
              cx="60" cy="60" r={R} fill="none" stroke="url(#es-loader-arc)" strokeWidth="3" strokeLinecap="round"
              strokeDasharray={`${(pct / 100) * C} ${C}`} transform="rotate(-90 60 60)"
              style={{ transition: 'stroke-dasharray 0.6s cubic-bezier(0.22,1,0.36,1)' }}
            />
          </svg>
          <span className="es-loader-satellite" />
          <span className="es-loader-satellite es-loader-satellite--slow" />
          <div className="es-loader-pct">{pct}<span>%</span></div>
        </div>

        <h3 className="es-loader-title">Opening the Embedding Space</h3>
        <p key={message} className="es-loader-message">{message}</p>

        <ol className="es-loader-stages" aria-label="Progress">
          {steps.map((s, i) => (
            <li key={i} className={`es-loader-stage is-${s.status}`} title={STAGE_COPY[s.base]?.title ?? s.base}>
              <span className="es-loader-dot" />
              <span className="es-loader-stage-label">{STAGE_COPY[s.base]?.title ?? s.base}</span>
            </li>
          ))}
        </ol>

        <p key={tip} className="es-loader-tip">{TIPS[tip]}</p>
      </div>
    </div>
  );
}
