// Original RDev Academy mark: a hexagonal frame (a "block"), a geometric R, and an orbiting spark.
export function Logo({ size = 96, animated = false }: { size?: number; animated?: boolean }) {
  return (
    <svg className={`logo ${animated ? 'logo-animated' : ''}`} viewBox="0 0 120 120" width={size} height={size} role="img" aria-label="RDev Academy logo">
      <defs>
        <linearGradient id="rdev-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" style={{ stopColor: 'var(--accent)' }} />
          <stop offset="1" style={{ stopColor: 'var(--accent2)' }} />
        </linearGradient>
      </defs>
      <ellipse className="logo-orbit" cx="60" cy="60" rx="56" ry="22" transform="rotate(-28 60 60)" fill="none" stroke="url(#rdev-g)" strokeWidth="1.2" strokeDasharray="3 6" opacity=".55" />
      <path className="logo-hex" d="M60 9L104 34.5V85.5L60 111L16 85.5V34.5Z" fill="none" stroke="url(#rdev-g)" strokeWidth="5" strokeLinejoin="round" />
      <path className="logo-hexfill" d="M60 9L104 34.5V85.5L60 111L16 85.5V34.5Z" fill="url(#rdev-g)" opacity=".1" />
      <path className="logo-r" d="M46 84V36H67Q81 36 81 49Q81 62 67 62H46M65 62L83 84" fill="none" stroke="url(#rdev-g)" strokeWidth="9" strokeLinecap="square" strokeLinejoin="miter" />
      <path className="logo-spark" d="M99 13l3.2 7.8L110 24l-7.8 3.2L99 35l-3.2-7.8L88 24l7.8-3.2z" fill="url(#rdev-g)" />
    </svg>
  );
}
