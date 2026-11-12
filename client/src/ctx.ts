import { createContext, useContext } from 'react';
import type { Model } from './model';
import type { User, Unit } from './types';

export interface Ctx {
  model: Model;
  user: User;
  canEdit: boolean;            // not view-only
  isAdmin: boolean;            // branch management: edits everything
  canEditTask: (id: number) => boolean;
  /** units the current user may assign as owner (own unit and below; all for admin) */
  assignable: Unit[];
  reload: () => Promise<void>;
  /** run an API call, refresh, report moved tasks or errors */
  run: <T>(fn: () => Promise<T>, okMsg?: string) => Promise<T | undefined>;
  toast: (msg: string, kind?: 'info' | 'ok' | 'error') => void;
  go: (hash: string) => void;
  openTask: (id: number) => void;          // open in the Gantt with the panel
  focusTask: (id: number) => void;         // open the impact map
  setSim: (s: SimOverlay | null) => void;
  undoRedo: (kind: 'undo' | 'redo') => void;
  sim: SimOverlay | null;
  /** add / remove a task from the favourites of the unit you entered as */
  toggleFavorite: (id: number) => void;
}

export interface SimOverlay {
  taskId: number;
  label: string;
  ghosts: Map<number, { start: string; finish: string; shift: number }>;
  blocked: Set<number>;
}

export const AppCtx = createContext<Ctx | null>(null);
export const useApp = () => {
  const c = useContext(AppCtx);
  if (!c) throw new Error('no app context');
  return c;
};

/** Extract the "moved" array returned by mutations into a short Hebrew message. */
export function movedMessage(r: unknown): string | null {
  const moved = (r as { moved?: unknown[] } | undefined)?.moved;
  if (!Array.isArray(moved) || !moved.length) return null;
  return moved.length === 1 ? 'משימה אחת זזה בעקבות השינוי' : `${moved.length} משימות זזו בעקבות השינוי`;
}
