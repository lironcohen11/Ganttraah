// Export of the plan from the main screen, generated in the browser (no libraries, works offline):
//  - Excel (.xlsx) with two sheets: the Gantt (one column per week, coloured bars) and the task list
//  - MS Project XML, which MS Project (and other planning tools) can open
import type { Model, Row } from './model';
import { STATUS_LABEL, DEP_LABEL } from './model';
import type { Task } from './types';
import { toDay, fromDay } from './dates';

/* ------------------------------------------------------------------ helpers */

const esc = (v: unknown) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  // characters that XML 1.0 does not allow
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const excelDate = (iso: string) => toDay(iso) + 25569; // days since 1899-12-30
const colName = (n: number) => { let s = ''; n++; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
const hex = (c: string) => (c || '#3b6fd8').replace('#', '').toUpperCase().padStart(6, '0').slice(0, 6);
/** the colour mixed with white (for the light part of a bar) */
const light = (c: string, k = 0.72) => {
  const h = hex(c);
  const ch = [0, 2, 4].map((i) => Math.round(parseInt(h.slice(i, i + 2), 16) + (255 - parseInt(h.slice(i, i + 2), 16)) * k));
  return ch.map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
};

export function download(name: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
export const fileStamp = (today: string) => today.split('-').reverse().join('.');

/* ------------------------------------------------------------------ a minimal ZIP (stored, no compression) */

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b: Uint8Array) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

function zip(files: { name: string; text: string }[]): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name), data = enc.encode(f.text), crc = crc32(data);
    const loc = new DataView(new ArrayBuffer(30));
    loc.setUint32(0, 0x04034b50, true); loc.setUint16(4, 20, true); loc.setUint16(6, 0x0800, true); loc.setUint16(8, 0, true);
    loc.setUint32(14, crc, true); loc.setUint32(18, data.length, true); loc.setUint32(22, data.length, true); loc.setUint16(26, name.length, true);
    parts.push(new Uint8Array(loc.buffer), name, data);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true); cen.setUint16(8, 0x0800, true);
    cen.setUint32(16, crc, true); cen.setUint32(20, data.length, true); cen.setUint32(24, data.length, true); cen.setUint16(28, name.length, true);
    cen.setUint32(42, offset, true);
    central.push(new Uint8Array(cen.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const cenSize = central.reduce((s, b) => s + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cenSize, true); end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(new ArrayBuffer(all.reduce((s, b) => s + b.length, 0)));
  let p = 0;
  for (const b of all) { out.set(b, p); p += b.length; }
  return out;
}

/* ------------------------------------------------------------------ xlsx styles */

interface StyleKey { font?: 'normal' | 'bold' | 'white' | 'muted' | 'title'; fill?: string; num?: 'date' | 'pct' | 'int'; align?: 'center' | 'right'; indent?: number; border?: boolean; wrap?: boolean }
class Styles {
  fills: string[] = [];
  xfs: string[] = [];
  map = new Map<string, number>();
  constructor() { this.get({}); }
  get(k: StyleKey) {
    const key = JSON.stringify(k);
    if (this.map.has(key)) return this.map.get(key)!;
    let fillId = 0;
    if (k.fill) { let i = this.fills.indexOf(k.fill); if (i < 0) { this.fills.push(k.fill); i = this.fills.length - 1; } fillId = i + 2; }
    const fontId = { normal: 0, bold: 1, white: 2, muted: 3, title: 4 }[k.font || 'normal'];
    const numId = k.num === 'date' ? 164 : k.num === 'pct' ? 9 : k.num === 'int' ? 1 : 0;
    const al = k.align || k.indent || k.wrap
      ? `<alignment${k.align ? ` horizontal="${k.align}"` : ''}${k.indent ? ` indent="${k.indent}"` : ''}${k.wrap ? ' wrapText="1"' : ''} vertical="center"/>`
      : '<alignment vertical="center"/>';
    this.xfs.push(`<xf numFmtId="${numId}" fontId="${fontId}" fillId="${fillId}" borderId="${k.border ? 1 : 0}" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">${al}</xf>`);
    this.map.set(key, this.xfs.length - 1);
    return this.xfs.length - 1;
  }
  xml() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yy"/></numFmts>
<fonts count="5">
<font><sz val="11"/><name val="Arial"/></font>
<font><b/><sz val="11"/><name val="Arial"/></font>
<font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Arial"/></font>
<font><sz val="10"/><color rgb="FF6B7484"/><name val="Arial"/></font>
<font><b/><sz val="14"/><name val="Arial"/></font>
</fonts>
<fills count="${this.fills.length + 2}"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>${this.fills.map((f) => `<fill><patternFill patternType="solid"><fgColor rgb="FF${f}"/><bgColor indexed="64"/></patternFill></fill>`).join('')}</fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFE2E6EC"/></left><right style="thin"><color rgb="FFE2E6EC"/></right><top style="thin"><color rgb="FFE2E6EC"/></top><bottom style="thin"><color rgb="FFE2E6EC"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="${this.xfs.length}">${this.xfs.join('')}</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
  }
}

type Cell = { v?: string | number | null; s?: number; date?: boolean } | null;
function sheetXml(rows: Cell[][], o: { widths: number[]; freezeRow: number; freezeCol: number; heights?: Map<number, number>; filter?: boolean; merges?: string[] }) {
  const cols = o.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
  const body = rows.map((r, ri) => {
    const cells = r.map((c, ci) => {
      if (!c) return '';
      const ref = colName(ci) + (ri + 1);
      const s = c.s ? ` s="${c.s}"` : '';
      if (c.v == null || c.v === '') return `<c r="${ref}"${s}/>`;
      if (typeof c.v === 'number') return `<c r="${ref}"${s}><v>${c.v}</v></c>`;
      return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(c.v)}</t></is></c>`;
    }).join('');
    const h = o.heights?.get(ri);
    return `<row r="${ri + 1}"${h ? ` ht="${h}" customHeight="1"` : ''}>${cells}</row>`;
  }).join('');
  const pane = o.freezeRow || o.freezeCol
    ? `<pane${o.freezeCol ? ` xSplit="${o.freezeCol}"` : ''}${o.freezeRow ? ` ySplit="${o.freezeRow}"` : ''} topLeftCell="${colName(o.freezeCol)}${o.freezeRow + 1}" activePane="bottomLeft" state="frozen"/>`
    : '';
  const lastCol = colName(Math.max(0, (rows[o.freezeRow - 1] || rows[0] || []).length - 1));
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetViews><sheetView rightToLeft="1" workbookViewId="0" zoomScale="100">${pane}</sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="18"/>
<cols>${cols}</cols>
<sheetData>${body}</sheetData>
${o.filter ? `<autoFilter ref="A${o.freezeRow}:${lastCol}${rows.length}"/>` : ''}
${o.merges?.length ? `<mergeCells count="${o.merges.length}">${o.merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : ''}
</worksheet>`;
}

/* ------------------------------------------------------------------ Excel */

export interface ExportScope { rows: Row[]; title: string }

export function exportExcel(m: Model, scope: ExportScope) {
  const st = new Styles();
  const today = m.data.today;
  const items = scope.rows.filter((r) => r.type !== 'group') as Exclude<Row, { type: 'group' }>[];
  const name = (r: (typeof items)[number]) => (r.type === 'project' ? r.project.name : r.task.name);
  const preds = (t: Task) => (m.depsIn.get(t.id) || []).map((d) => {
    const p = m.task(d.predecessor_id);
    if (!p) return '';
    return `${p.wbs} ${p.name}${d.type !== 'FS' ? ` (${DEP_LABEL[d.type]})` : ''}${d.lag ? ` ${d.lag > 0 ? '+' : ''}${d.lag} ימים` : ''}`;
  }).filter(Boolean).join('; ');
  const statusOf = (t: Task) => (t.kind === 'milestone' ? (t.percent >= 100 ? 'הושגה' : t.status === 'late' ? 'לא הושגה' : 'מתוכננת') : STATUS_LABEL[t.status]);
  const STATUS_FILL: Record<string, string> = { done: '00A35A', active: '3B7BE8', planned: 'C4C9D2', behind: 'F29A1F', late: 'E2445C' };

  // ---- sheet: task list
  const H = st.get({ font: 'white', fill: '2F5BD3', align: 'center', border: true, wrap: true });
  const list: Cell[][] = [];
  list.push([{ v: `${scope.title} · רשימת משימות · נכון ל-${fileStamp(today)}`, s: st.get({ font: 'title' }) }]);
  list.push(['מס׳', 'פרויקט', 'שם המשימה', 'סוג', 'משך (ימי עבודה)', 'התחלה', 'סיום', 'התקדמות', 'אחראי', 'מצב', 'תאריך יעד', 'חריגה מיעד', 'תלויה ב', 'הערות']
    .map((v) => ({ v, s: H })));
  for (const r of items) {
    if (r.type === 'project') {
      const p = r.project;
      const s = st.get({ font: 'bold', fill: 'EEF1F6', border: true });
      const sd = st.get({ font: 'bold', fill: 'EEF1F6', border: true, num: 'date', align: 'center' });
      const sp = st.get({ font: 'bold', fill: 'EEF1F6', border: true, num: 'pct', align: 'center' });
      list.push([{ v: '', s }, { v: p.name, s }, { v: p.name, s }, { v: 'פרויקט', s }, { v: '', s },
        { v: p.roots.length ? excelDate(p.start) : null, s: sd }, { v: p.roots.length ? excelDate(p.finish) : null, s: sd },
        { v: p.percent / 100, s: sp }, { v: '', s }, { v: '', s }, { v: '', s }, { v: '', s }, { v: '', s }, { v: p.description || '', s }]);
      continue;
    }
    const t = r.task;
    const bold = t.kind === 'summary';
    const base: StyleKey = { font: bold ? 'bold' : 'normal', border: true };
    const s = st.get(base);
    list.push([
      { v: t.wbs, s: st.get({ ...base, align: 'center' }) },
      { v: r.project.name, s },
      { v: t.name, s: st.get({ ...base, indent: Math.min(10, t.level) }) },
      { v: t.kind === 'milestone' ? 'אבן דרך' : t.kind === 'summary' ? 'אב-משימה' : 'משימה', s },
      { v: t.kind === 'milestone' ? 0 : t.work_days, s: st.get({ ...base, num: 'int', align: 'center' }) },
      { v: excelDate(t.start), s: st.get({ ...base, num: 'date', align: 'center' }) },
      { v: excelDate(t.finish), s: st.get({ ...base, num: 'date', align: 'center' }) },
      { v: t.percent / 100, s: st.get({ ...base, num: 'pct', align: 'center' }) },
      { v: m.ownerName(t.id), s },
      { v: statusOf(t), s: st.get({ font: t.status === 'planned' ? 'bold' : 'white', fill: STATUS_FILL[t.status], align: 'center', border: true }) },
      { v: t.deadline ? excelDate(t.deadline) : null, s: st.get({ ...base, num: 'date', align: 'center' }) },
      { v: t.deadline_missed ? 'כן' : '', s: t.deadline_missed ? st.get({ font: 'white', fill: 'E2445C', align: 'center', border: true }) : s },
      { v: preds(t), s: st.get({ ...base, wrap: true }) },
      { v: t.notes || '', s: st.get({ ...base, wrap: true }) },
    ]);
  }
  const listXml = sheetXml(list, { widths: [7, 22, 40, 11, 10, 11, 11, 10, 18, 11, 11, 9, 36, 40], freezeRow: 2, freezeCol: 3, filter: true, heights: new Map([[0, 26], [1, 32]]) });

  // ---- sheet: Gantt, one column per week (weeks start on Sunday)
  let lo = toDay(today), hi = toDay(today);
  for (const r of items) {
    const s = r.type === 'project' ? (r.project.roots.length ? r.project.start : null) : r.task.start;
    const f = r.type === 'project' ? (r.project.roots.length ? r.project.finish : null) : r.task.finish;
    if (s) lo = Math.min(lo, toDay(s));
    if (f) hi = Math.max(hi, toDay(f));
    if (r.type === 'task' && r.task.deadline) hi = Math.max(hi, toDay(r.task.deadline));
  }
  const sunday = (d: number) => d - new Date(d * 86400000).getUTCDay();
  const w0 = sunday(lo) - 7, w1 = sunday(hi) + 7;
  const weeks: number[] = [];
  for (let w = w0; w <= w1; w += 7) weeks.push(w);
  const FIXED = 5; // מס׳, שם, אחראי, התחלה, סיום
  const gantt: Cell[][] = [];
  const merges: string[] = [];
  gantt.push([{ v: `${scope.title} · גאנט (שבועות) · נכון ל-${fileStamp(today)}`, s: st.get({ font: 'title' }) }]);
  // month row and week row
  const HM = st.get({ font: 'bold', fill: 'E8EEFC', align: 'center', border: true });
  const months: Cell[] = [null, null, null, null, null];
  const weekRow: Cell[] = ['מס׳', 'שם המשימה', 'אחראי', 'התחלה', 'סיום'].map((v) => ({ v, s: H }));
  for (let i = 0; i < FIXED; i++) months[i] = { v: '', s: H };
  let mStart = 0;
  const monthName = (d: number) => new Intl.DateTimeFormat('he-IL', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(new Date(d * 86400000));
  weeks.forEach((w, i) => {
    const isToday = toDay(today) >= w && toDay(today) < w + 7;
    weekRow.push({ v: fromDay(w).slice(8, 10) + '/' + fromDay(w).slice(5, 7), s: isToday ? st.get({ font: 'white', fill: 'E11D48', align: 'center', border: true }) : st.get({ font: 'muted', fill: 'F4F6F9', align: 'center', border: true }) });
    const mo = fromDay(w).slice(0, 7);
    const next = weeks[i + 1] != null ? fromDay(weeks[i + 1]).slice(0, 7) : null;
    if (i === mStart) months.push({ v: monthName(w), s: HM }); else months.push({ v: '', s: HM });
    if (next !== mo) {
      if (i > mStart) merges.push(`${colName(FIXED + mStart)}2:${colName(FIXED + i)}2`);
      mStart = i + 1;
    }
  });
  gantt.push(months, weekRow);
  for (const r of items) {
    const isProj = r.type === 'project';
    const t = r.type === 'task' ? r.task : null;
    const color = r.project.color;
    const bold = isProj || t?.kind === 'summary';
    const base: StyleKey = { font: bold ? 'bold' : 'normal', border: true, fill: isProj ? 'EEF1F6' : undefined };
    const start = isProj ? (r.project.roots.length ? r.project.start : null) : t!.start;
    const finish = isProj ? (r.project.roots.length ? r.project.finish : null) : t!.finish;
    const pct = isProj ? r.project.percent : t!.percent;
    const row: Cell[] = [
      { v: t ? t.wbs : '', s: st.get({ ...base, align: 'center' }) },
      { v: name(r), s: st.get({ ...base, indent: t ? Math.min(10, t.level + 1) : 0 }) },
      { v: t ? m.ownerName(t.id) : '', s: st.get(base) },
      { v: start ? excelDate(start) : null, s: st.get({ ...base, num: 'date', align: 'center' }) },
      { v: finish ? excelDate(finish) : null, s: st.get({ ...base, num: 'date', align: 'center' }) },
    ];
    const empty = st.get({ border: true, fill: isProj ? 'F6F7FA' : undefined });
    if (!start || !finish) { weeks.forEach(() => row.push({ v: '', s: empty })); gantt.push(row); continue; }
    const s = toDay(start), f = toDay(finish);
    // the completed part of the bar: the first pct% of its days
    const doneUntil = s + Math.round(((f - s + 1) * pct) / 100) - 1;
    for (const w of weeks) {
      const we = w + 6;
      const dl = t?.deadline ? toDay(t.deadline) : null;
      if (t?.kind === 'milestone') {
        row.push(s >= w && s <= we ? { v: '◆', s: st.get({ font: 'bold', align: 'center', border: true, fill: t.percent >= 100 ? light(color, 0.35) : undefined }) }
          : dl != null && dl >= w && dl <= we ? { v: '▼', s: st.get({ border: true, align: 'center' }) } : { v: '', s: empty });
        continue;
      }
      if (we < s || w > f) {
        row.push(dl != null && dl >= w && dl <= we
          ? { v: '▼', s: st.get({ font: 'bold', align: 'center', border: true }) }
          : { v: '', s: empty });
        continue;
      }
      const solid = w <= doneUntil;
      const fill = t?.kind === 'summary' || isProj ? (solid ? '2B3445' : 'A3ABB8') : solid ? hex(color) : light(color);
      row.push({ v: dl != null && dl >= w && dl <= we ? '▼' : '', s: st.get({ fill, border: true, align: 'center', font: solid ? 'white' : 'normal' }) });
    }
    gantt.push(row);
  }
  // legend under the chart
  gantt.push([]);
  gantt.push([null, { v: 'מקרא: צבע מלא = הושלם, צבע בהיר = נותר. ◆ = אבן דרך. ▼ = תאריך יעד. העמודה האדומה = השבוע הנוכחי.', s: st.get({ font: 'muted' }) }]);
  const ganttXml = sheetXml(gantt, { widths: [7, 34, 16, 10, 10, ...weeks.map(() => 4.2)], freezeRow: 3, freezeCol: FIXED, merges, heights: new Map([[0, 26]]) });

  const files = [
    { name: '[Content_Types].xml', text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>` },
    { name: '_rels/.rels', text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<bookViews><workbookView activeTab="0"/></bookViews>
<sheets><sheet name="גאנט" sheetId="1" r:id="rId1"/><sheet name="רשימת משימות" sheetId="2" r:id="rId2"/></sheets>
${list.length > 2 ? `<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="1" hidden="1">'רשימת משימות'!$A$2:$N$${list.length}</definedName></definedNames>` : ''}
</workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>` },
    { name: 'xl/worksheets/sheet1.xml', text: ganttXml },
    { name: 'xl/worksheets/sheet2.xml', text: listXml },
    { name: 'xl/styles.xml', text: st.xml() }, // last: every style is known only after both sheets are built
  ];
  return zip(files);
}

/* ------------------------------------------------------------------ MS Project XML */

export function exportMsProject(m: Model, scope: ExportScope) {
  const items = scope.rows.filter((r) => r.type !== 'group') as Exclude<Row, { type: 'group' }>[];
  const dt = (iso: string, end = false) => `${iso}T${end ? '17:00:00' : '08:00:00'}`;
  const TYPE: Record<string, number> = { FF: 0, FS: 1, SS: 3 };
  const projUid = (pid: number) => 1000000 + pid; // projects become top-level summary tasks
  const shown = new Set(items.filter((r) => r.type === 'task').map((r) => (r as { task: Task }).task.id));
  let id = 0;
  const out: string[] = [];
  const start = items.reduce((a, r) => { const s = r.type === 'project' ? r.project.start : r.task.start; return !a || s < a ? s : a; }, '') || m.data.today;
  for (const r of items) {
    id++;
    if (r.type === 'project') {
      const p = r.project;
      const roots = p.roots.length;
      out.push(`<Task><UID>${projUid(p.id)}</UID><ID>${id}</ID><Name>${esc(p.name)}</Name><OutlineNumber>${p.sort_order || id}</OutlineNumber><OutlineLevel>1</OutlineLevel>
<Start>${dt(roots ? p.start : p.start_date)}</Start><Finish>${dt(roots ? p.finish : p.start_date, true)}</Finish><Summary>1</Summary><Milestone>0</Milestone>
<PercentComplete>${p.percent}</PercentComplete><Notes>${esc(p.description)}</Notes></Task>`);
      continue;
    }
    const t = r.task;
    const preds = (m.depsIn.get(t.id) || []).filter((d) => shown.has(d.predecessor_id)).map((d) =>
      `<PredecessorLink><PredecessorUID>${d.predecessor_id}</PredecessorUID><Type>${TYPE[d.type] ?? 1}</Type><CrossProject>0</CrossProject><LinkLag>${(d.lag | 0) * 4800}</LinkLag><LagFormat>7</LagFormat></PredecessorLink>`).join('');
    const ms = t.kind === 'milestone';
    const dur = ms ? 0 : t.work_days;
    out.push(`<Task><UID>${t.id}</UID><ID>${id}</ID><Name>${esc(t.name)}</Name><OutlineNumber>${esc(t.wbs)}</OutlineNumber><OutlineLevel>${t.level + 2}</OutlineLevel>
<Start>${dt(t.start)}</Start><Finish>${dt(t.finish, !ms)}</Finish><Duration>PT${dur * 8}H0M0S</Duration><DurationFormat>7</DurationFormat>
<Summary>${t.kind === 'summary' ? 1 : 0}</Summary><Milestone>${ms ? 1 : 0}</Milestone><PercentComplete>${t.percent}</PercentComplete>
${t.start_constraint ? `<ConstraintType>4</ConstraintType><ConstraintDate>${dt(t.start_constraint)}</ConstraintDate>` : '<ConstraintType>0</ConstraintType>'}
${t.deadline ? `<Deadline>${dt(t.deadline, true)}</Deadline>` : ''}<Notes>${esc([m.ownerName(t.id) && `אחראי: ${m.ownerName(t.id)}`, t.notes].filter(Boolean).join('\n'))}</Notes>${preds}</Task>`);
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Project xmlns="http://schemas.microsoft.com/project">
<Name>${esc(scope.title)}</Name><Title>${esc(scope.title)}</Title><StartDate>${dt(start)}</StartDate>
<ScheduleFromStart>1</ScheduleFromStart><MinutesPerDay>480</MinutesPerDay><MinutesPerWeek>2400</MinutesPerWeek><DaysPerMonth>20</DaysPerMonth>
<Tasks>
${out.join('\n')}
</Tasks>
</Project>`;
}
