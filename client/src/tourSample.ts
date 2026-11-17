import { Model } from './model';
import type { AppData } from './types';
import tourSample from './tour-sample.json';

/**
 * The sample project of the tour, moved to the current weeks (by whole weeks, so weekends and
 * work days stay where they were). Built in the browser only; it never reaches the server.
 */
export function sampleModel(today: string): Model {
  const src = tourSample as unknown as AppData & { today: string };
  const days = Math.round((Date.parse(today) - Date.parse(src.today)) / 864e5 / 7) * 7;
  const shift = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(Date.parse(v) + days * 864e5).toISOString().slice(0, 10) : v);
  const move = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, shift(v)])) as T;
  return new Model({ ...src, today, projects: src.projects.map(move), tasks: src.tasks.map(move) } as AppData);
}
