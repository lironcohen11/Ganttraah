// Working calendar: Sun-Thu working week + Israeli/Jewish holidays, computed offline
// from the ICU Hebrew calendar built into Node (no external data, no internet).
//
// Day numbers: integer days since 1970-01-01 (UTC). Work-day indices: consecutive
// integers over working days only, so scheduling arithmetic is plain integer math.

export const DAY_MS = 86400000;
export const toDay = (iso) => Math.floor(Date.parse(iso + 'T00:00:00Z') / DAY_MS);
export const fromDay = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);
export const weekday = (n) => new Date(n * DAY_MS).getUTCDay(); // 0 = Sunday

export const DEFAULT_CALENDAR = {
  workDays: [0, 1, 2, 3, 4], // Sunday..Thursday
  chagOff: true,             // Yom Tov days (Rosh Hashana, Yom Kippur, Sukkot, Pesach, Shavuot...)
  independenceOff: true,     // Yom HaAtzmaut
  cholHamoedOff: false,      // Chol HaMoed Sukkot / Pesach
  erevChagOff: false,        // Erev Chag
};

const hebFmt = new Intl.DateTimeFormat('en-u-ca-hebrew', {
  timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric',
});

function hebrew(day) {
  const parts = hebFmt.formatToParts(new Date(day * DAY_MS));
  const get = (t) => parts.find((p) => p.type === t).value;
  return { d: Number(get('day')), m: get('month'), y: Number(get('year')) };
}

// Fixed-date holidays. cat: chag | chol | erev
const FIXED = [
  ['Elul', 29, 'erev', 'ערב ראש השנה'],
  ['Tishri', 1, 'chag', 'ראש השנה'],
  ['Tishri', 2, 'chag', 'ראש השנה'],
  ['Tishri', 9, 'erev', 'ערב יום כיפור'],
  ['Tishri', 10, 'chag', 'יום כיפור'],
  ['Tishri', 14, 'erev', 'ערב סוכות'],
  ['Tishri', 15, 'chag', 'סוכות'],
  ['Tishri', 16, 'chol', 'חול המועד סוכות'],
  ['Tishri', 17, 'chol', 'חול המועד סוכות'],
  ['Tishri', 18, 'chol', 'חול המועד סוכות'],
  ['Tishri', 19, 'chol', 'חול המועד סוכות'],
  ['Tishri', 20, 'chol', 'חול המועד סוכות'],
  ['Tishri', 21, 'erev', 'הושענא רבה'],
  ['Tishri', 22, 'chag', 'שמחת תורה'],
  ['Nisan', 14, 'erev', 'ערב פסח'],
  ['Nisan', 15, 'chag', 'פסח'],
  ['Nisan', 16, 'chol', 'חול המועד פסח'],
  ['Nisan', 17, 'chol', 'חול המועד פסח'],
  ['Nisan', 18, 'chol', 'חול המועד פסח'],
  ['Nisan', 19, 'chol', 'חול המועד פסח'],
  ['Nisan', 20, 'erev', 'ערב שביעי של פסח'],
  ['Nisan', 21, 'chag', 'שביעי של פסח'],
  ['Sivan', 5, 'erev', 'ערב שבועות'],
  ['Sivan', 6, 'chag', 'שבועות'],
];
const FIXED_MAP = new Map(FIXED.map(([m, d, cat, label]) => [`${m}-${d}`, { cat, label }]));

// Yom HaAtzmaut: 5 Iyar, moved to Thursday if it falls on Fri/Sat, to Tuesday if on Monday.
function isIndependenceDay(day, h) {
  if (h.m !== 'Iyar') return false;
  const wd = weekday(day);
  if (h.d === 5) return wd !== 5 && wd !== 6 && wd !== 1;
  if (h.d === 4 || h.d === 3) return wd === 4 && (weekday(day + 1) === 5 || weekday(day + 2) === 6) &&
    hebrew(day + (5 - h.d)).d === 5;
  if (h.d === 6) return wd === 2;
  return false;
}

// ---- days shown for information only (cat 'info'): working days, but good to see in the plan

// Chanukah: 25 Kislev, eight days (ends on 2 or 3 Tevet)
function isChanukah(day, h) {
  if (h.m === 'Kislev') return h.d >= 25;
  if (h.m !== 'Tevet' || h.d > 3) return false;
  for (let k = 1; k <= 7; k++) { const x = hebrew(day - k); if (x.m === 'Kislev' && x.d === 25) return true; }
  return false;
}
// Purim: 14 Adar (Adar II in a leap year)
const isPurim = (h) => h.d === 14 && (h.m === 'Adar' || h.m === 'Adar II');
// Yom HaShoah: 27 Nisan; Friday -> Thursday, Sunday -> Monday
function isShoah(day, h) {
  if (h.m !== 'Nisan') return false;
  const wd = weekday(day);
  if (h.d === 27) return wd !== 5 && wd !== 0;
  if (h.d === 26) return wd === 4;   // 27 Nisan was a Friday
  if (h.d === 28) return wd === 1;   // 27 Nisan was a Sunday
  return false;
}
// Tisha B'Av: 9 Av, moved to Sunday when it falls on Saturday
function isTishaBeAv(day, h) {
  if (h.m !== 'Av') return false;
  if (h.d === 9) return weekday(day) !== 6;
  if (h.d === 10) return weekday(day) === 0;
  return false;
}

// Sigd: 29 Heshvan, moved to Thursday when it falls on Saturday. Shown for information only:
// it is an official holiday but not a day off for everyone, so it never stops the work.
function isSigd(day, h) {
  if (h.m !== 'Heshvan') return false;
  if (h.d === 29) return weekday(day) !== 6;
  if (h.d === 27) return weekday(day) === 4 && hebrew(day + 2).d === 29 && hebrew(day + 2).m === 'Heshvan';
  return false;
}

/** Holiday info for one day, or null. cat 'info' = shown, never a day off. */
export function holidayOf(day) {
  const h = hebrew(day);
  const f = FIXED_MAP.get(`${h.m}-${h.d}`);
  if (f) return f;
  if (isIndependenceDay(day, h)) return { cat: 'independence', label: 'יום העצמאות' };
  if (h.m === 'Iyar' && h.d <= 5 && isIndependenceDay(day + 1, hebrew(day + 1))) return { cat: 'info', label: 'יום הזיכרון' };
  if (isChanukah(day, h)) return { cat: 'info', label: 'חנוכה' };
  if (h.m === 'Shevat' && h.d === 15) return { cat: 'info', label: 'ט"ו בשבט' };
  if (isPurim(h)) return { cat: 'info', label: 'פורים' };
  if (isShoah(day, h)) return { cat: 'info', label: 'יום השואה' };
  if (h.m === 'Iyar' && h.d === 18) return { cat: 'info', label: 'ל"ג בעומר' };
  if (h.m === 'Iyar' && h.d === 28) return { cat: 'info', label: 'יום ירושלים' };
  if (isTishaBeAv(day, h)) return { cat: 'info', label: 'תשעה באב' };
  if (isSigd(day, h)) return { cat: 'info', label: 'חג הסיגד' };
  return null;
}

const holidayCache = new Map();
function cachedHoliday(day) {
  if (!holidayCache.has(day)) holidayCache.set(day, holidayOf(day));
  return holidayCache.get(day);
}

/**
 * Build a calendar object for a day range.
 * settings: DEFAULT_CALENDAR shape; exceptions: [{day:'YYYY-MM-DD', kind:'off'|'work', label}]
 */
export function buildCalendar(settings, exceptions, fromDayN, toDayN) {
  const s = { ...DEFAULT_CALENDAR, ...(settings || {}) };
  const exc = new Map((exceptions || []).map((e) => [toDay(e.day), e]));
  const offByCat = { chag: s.chagOff, chol: s.cholHamoedOff, erev: s.erevChagOff, independence: s.independenceOff, info: false };

  function dayInfo(day) {
    const e = exc.get(day);
    const hol = cachedHoliday(day);
    if (e) return { work: e.kind === 'work', label: e.label || hol?.label || '', cat: 'exception' };
    if (!s.workDays.includes(weekday(day))) return { work: false, label: hol?.label || '', cat: hol?.cat || 'weekend' };
    if (hol) return { work: !offByCat[hol.cat], label: hol.label, cat: hol.cat };
    return { work: true, label: '', cat: null };
  }

  const from = fromDayN;
  let to = toDayN;
  let nextIdx = [];   // for each day offset: index of first work day >= day
  let workList = [];  // work-day index -> day number

  function build() {
    nextIdx = new Array(to - from + 2);
    workList = [];
    const isWork = [];
    for (let d = from; d <= to; d++) isWork.push(dayInfo(d).work);
    let count = 0;
    for (let i = 0; i <= to - from; i++) if (isWork[i]) count++;
    // walk backwards so nextIdx[i] = index of first work day at/after i
    let idx = count;
    nextIdx[to - from + 1] = count;
    for (let i = to - from; i >= 0; i--) {
      if (isWork[i]) idx--;
      nextIdx[i] = idx;
    }
    for (let i = 0; i <= to - from; i++) if (isWork[i]) workList.push(from + i);
  }
  build();

  const ensure = (idx) => {
    while (idx >= workList.length - 1) { to += 3650; build(); }
  };

  return {
    from,
    get to() { return to; },
    dayInfo,
    isWork: (day) => dayInfo(day).work,
    /** index of first work day on/after the given day */
    idxOf(day) {
      if (day < from) return 0;
      while (day > to) { to += 3650; build(); }
      return nextIdx[day - from];
    },
    /** day number of a work-day index */
    dayOf(idx) {
      if (idx < 0) return workList[0] + idx; // out of range: best effort
      ensure(idx);
      return workList[idx];
    },
    /** working days between two dates inclusive */
    workDaysBetween(a, b) {
      if (b < a) return 0;
      return this.idxOf(b + 1) - this.idxOf(a);
    },
  };
}

/** List holidays in a Gregorian year (for the settings screen and the Gantt header). */
export function holidaysInRange(fromDayN, toDayN) {
  const out = [];
  for (let d = fromDayN; d <= toDayN; d++) {
    const h = cachedHoliday(d);
    if (h) out.push({ day: fromDay(d), ...h });
  }
  return out;
}

/** Expand special-day ranges [{start_day, end_day, kind, label}] into single days. */
export function expandRanges(list) {
  const out = [];
  for (const r of list || []) {
    for (let d = toDay(r.start_day); d <= toDay(r.end_day); d++) out.push({ day: fromDay(d), kind: r.kind, label: r.label || '' });
  }
  return out;
}
