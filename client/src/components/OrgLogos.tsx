import { useState } from 'react';

/**
 * Organisation logos. To use the real ones, put the image files here:
 *   client/public/org/logo-1.png   and   client/public/org/logo-2.png
 * then rebuild (start.bat). Until a file exists, a neutral circle is shown in its place.
 */
const LOGOS = [
  { src: '/org/logo-1.png', alt: 'סמל ארגון' },
  { src: '/org/logo-2.png', alt: 'סמל יחידה' },
];

export function OrgLogos({ size = 30 }: { size?: number }) {
  return (
    <span className="org-logos">
      {LOGOS.map((l) => <OrgLogo key={l.src} {...l} size={size} />)}
    </span>
  );
}

function OrgLogo({ src, alt, size }: { src: string; alt: string; size: number }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <span className="org-logo placeholder" style={{ width: size, height: size }} title={`${alt} (יוחלף בסמל האמיתי)`} />;
  return <img className="org-logo" src={src} alt={alt} title={alt} style={{ width: size, height: size }} onError={() => setFailed(true)} />;
}
