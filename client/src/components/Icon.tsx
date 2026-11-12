const PATHS: Record<string, string> = {
  chevronDown: 'M6 9l6 6 6-6',
  chevronLeft: 'M15 6l-6 6 6 6',
  chevronRight: 'M9 6l6 6-6 6',
  plus: 'M12 5v14M5 12h14',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3',
  indent: 'M3 6h18M10 12h11M10 18h11M7 10l-4 2 4 2',
  outdent: 'M3 6h18M3 12h11M3 18h11M17 10l4 2-4 2',
  up: 'M12 19V5M6 11l6-6 6 6',
  down: 'M12 5v14M6 13l6 6 6-6',
  link: 'M10 14a4 4 0 005.66 0l3-3a4 4 0 00-5.66-5.66l-1 1M14 10a4 4 0 00-5.66 0l-3 3a4 4 0 005.66 5.66l1-1',
  diamond: 'M12 3l9 9-9 9-9-9z',
  flag: 'M5 21V4M5 4h11l-2 4 2 4H5',
  alert: 'M12 9v4M12 17h.01M10.3 3.9L2.4 18a2 2 0 001.7 3h15.8a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z',
  x: 'M6 6l12 12M18 6L6 18',
  focus: 'M12 12m-3 0a3 3 0 106 0 3 3 0 10-6 0M12 2v4M12 18v4M2 12h4M18 12h4',
  present: 'M3 4h18v12H3zM8 20h8M12 16v4',
  history: 'M3 12a9 9 0 109-9 9 9 0 00-6.4 2.6L3 8M3 3v5h5M12 7v5l3 3',
  settings: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.9l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.9-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 01-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.9.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.9 1.7 1.7 0 00-1.5-1H3a2 2 0 010-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.9l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.9.3H9a1.7 1.7 0 001-1.5V3a2 2 0 014 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.9-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.9V9a1.7 1.7 0 001.5 1H21a2 2 0 010 4h-.1a1.7 1.7 0 00-1.5 1z',
  gantt: 'M4 5h9M8 12h10M6 19h7',
  logout: 'M15 4h4a1 1 0 011 1v14a1 1 0 01-1 1h-4M10 17l-5-5 5-5M5 12h11',
  expand: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  today: 'M4 6h16v14H4zM4 10h16M9 3v4M15 3v4M12 14.5h.01',
  sim: 'M13 2L4 14h7l-1 8 9-12h-7z',
  edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  user: 'M12 12a4 4 0 100-8 4 4 0 000 8zM4 21a8 8 0 0116 0',
  calendar: 'M4 6h16v14H4zM4 10h16M9 3v4M15 3v4',
  layers: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5',
  check: 'M5 12l5 5 9-10',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 100-6 3 3 0 000 6z',
  filter: 'M3 5h18l-7 8v6l-4-2v-4z',
  undo:'M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 010 11H11',
  redo: 'M15 14l5-5-5-5M20 9H9.5a5.5 5.5 0 000 11H13',
  // dependency map: one task in the middle, linked to tasks on both sides
  deps: 'M12 12m-2.5 0a2.5 2.5 0 105 0 2.5 2.5 0 10-5 0M4 6.5m-2 0a2 2 0 104 0 2 2 0 10-4 0M4 17.5m-2 0a2 2 0 104 0 2 2 0 10-4 0M20 12m-2 0a2 2 0 104 0 2 2 0 10-4 0M5.8 7.6l3.9 3.1M5.8 16.4l3.9-3.1M14.5 12H18',
  star: 'M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z',
  hover: 'M9 4v9l2.2-2 1.8 4.2 2-.9-1.8-4.1H16zM18 4.5a3 3 0 11-.01 0M18 3.5v1.3l.9.9',
  click: 'M9 9l5 12 1.8-5.2L21 14zM5 3.5l1 1.8M3.5 7.5l1.8.4M9.5 3l-.3 2',
  legend: 'M4 6h3M4 12h3M4 18h3M10 6h10M10 12h10M10 18h10',
  refresh: 'M20 11a8 8 0 10-2.3 5.7M20 4v7h-7',
  grip: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  upload: 'M12 16V5M7 10l5-5 5 5M5 20h14',
  sun: 'M12 16a4 4 0 100-8 4 4 0 000 8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8 8 0 019.5 4a8 8 0 1010.5 10.5z',
  auto: 'M12 3a9 9 0 100 18 9 9 0 000-18zM12 3v18M12 7.5h4M12 12h5M12 16.5h4',
  table: 'M4 5h16v14H4zM4 10h16M4 15h16M10 5v14',
  file: 'M14 3H6v18h12V7zM14 3v4h4M9 13h6M9 17h6',
  lock: 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 017 0v3',
  info: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 11v5M12 8h.01',
};

export function Icon({ name, size = 16, className, strokeWidth = 2, fill }: { name: keyof typeof PATHS | string; size?: number; className?: string; strokeWidth?: number; fill?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={fill || 'none'} stroke="currentColor" strokeWidth={strokeWidth}
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d={PATHS[name] || ''} />
    </svg>
  );
}
