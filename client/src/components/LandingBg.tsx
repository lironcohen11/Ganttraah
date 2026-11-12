/**
 * A quiet background for the landing page, drawn in code (no image file): one large drawing,
 * like the logo — a few Gantt bars at the bottom, and from the top bar a rocket launches up across
 * the page with its trail and a signal. Very transparent; it drifts slightly (not with reduced motion).
 */
const NAVY = 'var(--lbg-navy)', ORANGE = '#e8833a';

export function LandingBg() {
  return (
    <svg className="landing-bg" viewBox="0 0 1440 900" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <g className="lbg-art">
        {/* the Gantt: three rows of bars, the top one turns into the rocket's trail */}
        <g opacity=".07">
          <rect x="40" y="660" width="330" height="44" rx="10" fill={NAVY} />
          <rect x="160" y="730" width="120" height="44" rx="10" fill={NAVY} />
          <rect x="310" y="730" width="420" height="44" rx="10" fill={NAVY} />
          <rect x="40" y="800" width="150" height="44" rx="10" fill={NAVY} />
          <rect x="220" y="800" width="380" height="44" rx="10" fill={NAVY} />
        </g>
        <path d="M400,660 H520 C760,660 930,560 1080,330 L1100,300 V346 C950,600 770,704 520,704 H400 Z" fill={ORANGE} opacity=".08" />
        {/* the rocket */}
        <g className="lbg-rocket" opacity=".1">
          <g transform="translate(1135 255) rotate(38)">
            <path d="M0,-80 C34,-46 38,12 22,58 L-22,58 C-38,12 -34,-46 0,-80 Z" fill={NAVY} />
            <circle cx="0" cy="-16" r="12" fill="var(--bg)" />
            <path d="M-22,28 L-48,66 L-22,58 Z M22,28 L48,66 L22,58 Z" fill={NAVY} />
          </g>
          {/* signal */}
          <g fill="none" stroke={ORANGE} strokeWidth="12" strokeLinecap="round">
            <path d="M1190,140 A90,90 0 0 1 1262,214" />
            <path d="M1205,88 A150,150 0 0 1 1318,204" opacity=".8" />
            <path d="M1220,36 A210,210 0 0 1 1372,194" opacity=".6" />
          </g>
        </g>
      </g>
    </svg>
  );
}
