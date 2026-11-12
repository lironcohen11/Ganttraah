// Reading a spreadsheet in the browser for the import (no libraries, works offline):
// .xlsx is unzipped with the browser's own DecompressionStream; .csv is read as text.
// Then the columns are matched to our fields by their header names (a fixed list, no AI).

export interface Cell { text: string; num: number | null; indent: number }
export interface Sheet { name: string; rows: Cell[][] }

/* ------------------------------------------------------------------ xlsx */

async function unzip(buf: ArrayBuffer): Promise<Map<string, string>> {
  const v = new DataView(buf), u8 = new Uint8Array(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 70000); i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('הקובץ לא נראה כמו קובץ Excel תקין (xlsx).');
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const out = new Map<string, string>();
  for (let n = 0; n < count; n++) {
    if (v.getUint32(p, true) !== 0x02014b50) break;
    const method = v.getUint16(p + 10, true), csize = v.getUint32(p + 20, true);
    const nlen = v.getUint16(p + 28, true), elen = v.getUint16(p + 30, true), clen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + elen + clen;
    if (!/\.xml$|\.rels$/.test(name)) continue;
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const data = u8.slice(start, start + csize);
    if (method === 0) out.set(name, dec.decode(data));
    else if (method === 8) {
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      out.set(name, await new Response(stream).text());
    }
  }
  return out;
}

const colIndex = (ref: string) => { let n = 0; for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };
const xml = (s: string) => new DOMParser().parseFromString(s, 'application/xml');
const byTag = (el: Document | Element, tag: string) => [...el.getElementsByTagName(tag)];

export async function readXlsx(buf: ArrayBuffer): Promise<Sheet[]> {
  const files = await unzip(buf);
  const wb = files.get('xl/workbook.xml');
  if (!wb) throw new Error('לא נמצאו גיליונות בקובץ.');
  const rels = xml(files.get('xl/_rels/workbook.xml.rels') || '<r/>');
  const target = new Map(byTag(rels, 'Relationship').map((r) => [r.getAttribute('Id')!, r.getAttribute('Target')!]));
  const shared = files.has('xl/sharedStrings.xml')
    ? byTag(xml(files.get('xl/sharedStrings.xml')!), 'si').map((si) => byTag(si, 't').map((t) => t.textContent || '').join(''))
    : [];
  // indentation of each cell style (a way some files show the hierarchy)
  const indents = files.has('xl/styles.xml')
    ? byTag(byTag(xml(files.get('xl/styles.xml')!), 'cellXfs')[0] || xml('<x/>').documentElement, 'xf')
      .map((xf) => Number(byTag(xf, 'alignment')[0]?.getAttribute('indent') || 0))
    : [];
  const sheets: Sheet[] = [];
  for (const s of byTag(xml(wb), 'sheet')) {
    const rid = s.getAttribute('r:id') || s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') || '';
    let path = target.get(rid) || '';
    path = path.startsWith('/') ? path.slice(1) : 'xl/' + path.replace(/^\.\//, '');
    const text = files.get(path);
    if (!text) continue;
    const rows: Cell[][] = [];
    for (const row of byTag(xml(text), 'row')) {
      const ri = Number(row.getAttribute('r') || rows.length + 1) - 1;
      const cells: Cell[] = [];
      for (const c of byTag(row, 'c')) {
        const ci = colIndex(c.getAttribute('r') || 'A1');
        const t = c.getAttribute('t');
        const vEl = byTag(c, 'v')[0];
        let txt = '', num: number | null = null;
        if (t === 's') txt = shared[Number(vEl?.textContent)] ?? '';
        else if (t === 'inlineStr') txt = byTag(c, 't').map((x) => x.textContent || '').join('');
        else if (t === 'b') txt = vEl?.textContent === '1' ? 'TRUE' : 'FALSE';
        else { txt = vEl?.textContent ?? ''; if (txt !== '' && t !== 'str' && t !== 'e' && !isNaN(Number(txt))) num = Number(txt); }
        cells[ci] = { text: txt.trim(), num, indent: indents[Number(c.getAttribute('s') || 0)] || 0 };
      }
      rows[ri] = cells;
    }
    sheets.push({ name: s.getAttribute('name') || `גיליון ${sheets.length + 1}`, rows: Array.from(rows, (r) => r || []) });
  }
  return sheets;
}

/* ------------------------------------------------------------------ csv */

export function readCsv(text: string): Sheet[] {
  text = text.replace(/^﻿/, '');
  const first = text.split(/\r?\n/)[0] || '';
  const delim = [',', ';', '\t'].sort((a, b) => first.split(b).length - first.split(a).length)[0];
  const rows: Cell[][] = [];
  let row: Cell[] = [], cur = '', q = false;
  const push = () => { const lead = cur.match(/^ */)![0].length; const s = cur.trim(); row.push({ text: s, num: s !== '' && !isNaN(Number(s)) ? Number(s) : null, indent: Math.floor(lead / 2) }); cur = ''; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; continue; }
    if (ch === '"') q = true;
    else if (ch === delim) push();
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; push(); rows.push(row); row = []; }
    else cur += ch;
  }
  if (cur || row.length) { push(); rows.push(row); }
  return [{ name: 'CSV', rows }];
}

/* ------------------------------------------------------------------ matching columns to our fields */

export type Field = 'ignore' | 'name' | 'wbs' | 'start' | 'finish' | 'duration' | 'percent' | 'owner' | 'deadline' | 'notes' | 'preds';
export const FIELDS: { id: Field; label: string }[] = [
  { id: 'ignore', label: 'לא לייבא' },
  { id: 'name', label: 'שם המשימה' },
  { id: 'wbs', label: 'מספור / היררכיה (1, 1.1, 1.2)' },
  { id: 'start', label: 'תאריך התחלה' },
  { id: 'finish', label: 'תאריך סיום' },
  { id: 'duration', label: 'משך (ימי עבודה)' },
  { id: 'percent', label: 'התקדמות (%)' },
  { id: 'owner', label: 'אחראי' },
  { id: 'deadline', label: 'תאריך יעד' },
  { id: 'notes', label: 'הערות' },
  { id: 'preds', label: 'תלויה ב (מספרים)' },
];
const SYN: Record<Exclude<Field, 'ignore'>, string[]> = {
  name: ['שם', 'שם משימה', 'שם המשימה', 'משימה', 'נושא', 'task', 'task name', 'name', 'title', 'activity'],
  wbs: ['מס', 'מספר', 'מספור', 'wbs', 'id', '#', 'מזהה', 'outline', 'outline number', 'סעיף'],
  start: ['התחלה', 'תאריך התחלה', 'מועד התחלה', 'start', 'start date', 'begin', 'מתאריך'],
  finish: ['סיום', 'תאריך סיום', 'מועד סיום', 'finish', 'end', 'end date', 'finish date', 'עד תאריך'],
  duration: ['משך', 'משך בימים', 'ימי עבודה', 'ימים', 'duration', 'days'],
  percent: ['התקדמות', 'אחוז', 'אחוז ביצוע', 'ביצוע', '%', 'percent', '% complete', 'percent complete', 'progress', 'complete'],
  owner: ['אחראי', 'אחריות', 'צוות', 'מסגרת', 'מבצע', 'גורם מבצע', 'owner', 'assigned to', 'resource', 'resource names', 'responsible'],
  deadline: ['תאריך יעד', 'יעד', 'deadline', 'target', 'due date', 'due'],
  notes: ['הערות', 'הערה', 'תיאור', 'notes', 'comments', 'description'],
  preds: ['תלויה ב', 'תלוי ב', 'תלויות', 'קודמות', 'משימות קודמות', 'predecessors', 'depends on', 'dependencies'],
};
const norm = (s: string) => s.toLowerCase().replace(/[׳'"`׳״]/g, '').replace(/[\s_\-:.()]+/g, ' ').trim();

/** a first guess for each column, from its header; the user confirms or changes it */
export function guessFields(headers: string[]): Field[] {
  const used = new Set<Field>();
  const pick = (h: string): Field => {
    const n = norm(h);
    if (!n) return 'ignore';
    for (const [f, list] of Object.entries(SYN) as [Field, string[]][]) if (!used.has(f) && list.some((x) => norm(x) === n)) return f;
    for (const [f, list] of Object.entries(SYN) as [Field, string[]][]) if (!used.has(f) && list.some((x) => norm(x).length > 2 && n.includes(norm(x)))) return f;
    return 'ignore';
  };
  return headers.map((h) => { const f = pick(h); if (f !== 'ignore') used.add(f); return f; });
}

/** the first row that looks like a header: several texts, no dates */
export function headerRow(rows: Cell[][]) {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const texts = (rows[i] || []).filter((c) => c && c.text && c.num == null);
    if (texts.length >= 2) return i;
  }
  return 0;
}

/* ------------------------------------------------------------------ values */

const pad = (n: number) => String(n).padStart(2, '0');
/** a date from an Excel serial number or a text like 15/11/2026, 15.11.26 or 2026-11-15 */
export function toIso(c: Cell | undefined): string | null {
  if (!c) return null;
  if (c.num != null && c.num > 20000 && c.num < 80000) {
    const d = new Date(Math.round((c.num - 25569) * 86400000));
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
  const s = c.text.trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`;
  m = s.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})/);
  if (m) { const y = m[3].length === 2 ? 2000 + +m[3] : +m[3]; return `${y}-${pad(+m[2])}-${pad(+m[1])}`; }
  return null;
}
export function toPercent(c: Cell | undefined, fraction: boolean) {
  if (!c) return 0;
  if (c.num != null) return Math.round(Math.max(0, Math.min(100, fraction ? c.num * 100 : c.num)));
  const n = parseFloat(c.text.replace('%', ''));
  return isNaN(n) ? 0 : Math.round(Math.max(0, Math.min(100, n)));
}
export function toNumber(c: Cell | undefined) {
  if (!c) return null;
  if (c.num != null) return c.num;
  const n = parseFloat(c.text.replace(/[^\d.]/g, ''));
  return isNaN(n) ? null : n;
}
/** "3, 5FS+2, 7SS" -> references with type and lag */
export function parsePreds(s: string) {
  return s.split(/[,;،\s]+/).map((x) => x.trim()).filter(Boolean).map((x) => {
    const m = x.match(/^([\d.]+)(FS|SS|FF|SF|הס|הה|סס)?([+-]\d+)?/i);
    if (!m) return null;
    const t = (m[2] || 'FS').toUpperCase();
    return { ref: m[1], type: t === 'SS' || t === 'הה' ? 'SS' : t === 'FF' || t === 'סס' ? 'FF' : 'FS', lag: m[3] ? Number(m[3]) : 0 };
  }).filter(Boolean) as { ref: string; type: 'FS' | 'SS' | 'FF'; lag: number }[];
}
