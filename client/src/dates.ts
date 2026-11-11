// Day numbers = whole days since 1970-01-01 UTC. All dates in the app are 'YYYY-MM-DD'.
export const DAY = 86400000;
export const toDay = (iso: string) => Math.floor(Date.parse(iso + 'T00:00:00Z') / DAY);
export const fromDay = (n: number) => new Date(n * DAY).toISOString().slice(0, 10);
export const weekday = (n: number) => new Date(n * DAY).getUTCDay();

const f = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('he-IL', { timeZone: 'UTC', ...o });
const fShort = f({ day: '2-digit', month: '2-digit', year: '2-digit' });
const fDM = f({ day: 'numeric', month: 'numeric' });
const fLong = f({ day: 'numeric', month: 'long', year: 'numeric' });
const fMonthYear = f({ month: 'long', year: 'numeric' });
const fMonth = f({ month: 'short' });
const fWeekday = f({ weekday: 'short' });
const fDateTime = new Intl.DateTimeFormat('he-IL', { day: 'numeric', month: 'numeric', year: '2-digit', hour: '2-digit', minute: '2-digit' });

const d = (iso: string) => new Date(iso + 'T00:00:00Z');
export const fmtDate = (iso?: string | null) => (iso ? fShort.format(d(iso)) : '—');
export const fmtDM = (iso?: string | null) => (iso ? fDM.format(d(iso)) : '—');
export const fmtLong = (iso?: string | null) => (iso ? fLong.format(d(iso)) : '—');
export const fmtMonthYear = (day: number) => fMonthYear.format(new Date(day * DAY));
export const fmtMonth = (day: number) => fMonth.format(new Date(day * DAY));
export const fmtWeekday = (iso: string) => fWeekday.format(d(iso));
export const fmtDateTime = (ts: string) => fDateTime.format(new Date(ts));

export const HEB_DAYS = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];

export class WorkCalendar {
  private map = new Map<number, { off: boolean; label: string }>();
  constructor(private workDays: number[], days: { d: string; off: boolean; label: string }[]) {
    for (const x of days) this.map.set(toDay(x.d), { off: x.off, label: x.label });
  }
  isWork(day: number) {
    const e = this.map.get(day);
    return e ? !e.off : this.workDays.includes(weekday(day));
  }
  label(day: number) { return this.map.get(day)?.label || ''; }
  nextWork(day: number) { let x = day; for (let i = 0; i < 400 && !this.isWork(x); i++) x++; return x; }
  /** working days from a to b inclusive */
  between(a: number, b: number) {
    let n = 0;
    for (let x = a; x <= b; x++) if (this.isWork(x)) n++;
    return n;
  }
  /** the day on which a task of n working days starting at `start` ends */
  finishOf(start: number, n: number) {
    let x = this.nextWork(start);
    let left = Math.max(1, n) - 1;
    while (left > 0) { x++; if (this.isWork(x)) left--; }
    return x;
  }
}

export const plural = (n: number, one: string, many: string) => (n === 1 ? one : `${n} ${many}`);
export const daysText = (n: number) => (Math.abs(n) === 1 ? 'יום אחד' : `${Math.abs(n)} ימים`);
