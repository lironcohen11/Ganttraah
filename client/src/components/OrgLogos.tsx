import { useState } from 'react';

/**
 * Organisation logos. To use the real ones, put the image files here:
 *   client/public/org/logo-1.png   and   client/public/org/logo-2.png
 * then rebuild (start.bat). Until a file exists, a neutral circle is shown in its place.
 * (For the single-file demo, also copy them to client/src/assets/org/.)
 */
// the single-file demo has no folder next to it: there the logos are built into the file
import demoLogo1 from '../assets/org/logo-1.png';
import demoLogo2 from '../assets/org/logo-2.png';

const DEMO = import.meta.env.VITE_DEMO === '1';
const LOGOS = [
  { src: DEMO ? demoLogo1 : '/org/logo-1.png', alt: 'סמל ארגון' },
  { src: DEMO ? demoLogo2 : '/org/logo-2.png', alt: 'סמל יחידה' },
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
