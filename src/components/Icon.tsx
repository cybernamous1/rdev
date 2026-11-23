const ICONS: Record<string, string> = {
  home: 'M3 11l9-8 9 8M5 10v10h14V10M10 20v-6h4v6',
  compass: 'M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0M15.5 8.5l-2 5-5 2 2-5z',
  book: 'M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2zM4 19V5M8 7h7',
  code: 'M8 8l-5 4 5 4M16 8l5 4-5 4M14 5l-4 14',
  database: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  bookmark: 'M6 3h12v18l-6-4-6 4z',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  checkCircle: 'M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0M8 12.5l3 3 5-6',
  settings: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4',
  info: 'M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0M12 11v5M12 8h.01',
  search: 'M11 4a7 7 0 1 0 0 14a7 7 0 0 0 0-14zM20 20l-4-4',
  menu: 'M4 7h16M4 12h16M4 17h16',
  x: 'M6 6l12 12M18 6L6 18',
  chevR: 'M9 6l6 6-6 6',
  chevL: 'M15 6l-6 6 6 6',
  clock: 'M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0M12 7v5l3 2',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5H5V6h5',
  reset: 'M4 12a8 8 0 1 0 3-6.2M4 4v4h4',
  sparkles: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM9 12l2 2 4-4',
  grad: 'M2 9l10-5 10 5-10 5zM6 11.5V16c3 2.5 9 2.5 12 0v-4.5',
  alert: 'M12 4l9 16H3zM12 10v4M12 17h.01',
  download: 'M12 4v11M7 11l5 5 5-5M5 20h14',
  upload: 'M12 16V5M7 9l5-5 5 5M5 20h14',
  trash: 'M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13',
  wifi: 'M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 20h.01',
  wifiOff: 'M3 3l18 18M8.5 16a5 5 0 0 1 7 0M5 12.5a10 10 0 0 1 3-2M12 20h.01',
  studio: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5',
  ui: 'M3 5h18v14H3zM3 10h18M9 10v9',
  map: 'M9 4l-6 2v14l6-2 6 2 6-2V4l-6 2zM9 4v14M15 6v14',
  bolt: 'M13 3L5 14h6l-1 7 8-11h-6z',
  network: 'M12 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM5 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 9v3M12 12l-6 3M12 12l6 3',
  cube: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5',
  briefcase: 'M4 8h16v11H4zM9 8V5h6v3M4 13h16',
  save: 'M5 4h11l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5',
  file: 'M6 3h8l5 5v13H6zM14 3v5h5',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  refresh: 'M20 6v5h-5M4 18v-5h5M19 11a7 7 0 0 0-12-3M5 13a7 7 0 0 0 12 3',
  list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  tag: 'M3 12V4h8l10 10-8 8zM7.5 8h.01',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  lock: 'M6 11h12v9H6zM8 11V8a4 4 0 0 1 8 0v3',
  layers: 'M12 3l9 5-9 5-9-5zM3 12.5l9 5 9-5'
};

export type IconName = keyof typeof ICONS;
export function Icon({ name, size = 18, className }: { name: string; size?: number; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={ICONS[name] || ICONS.info} />
    </svg>
  );
}
