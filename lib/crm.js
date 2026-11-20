'use strict';
/* Reads the daily used-stock export from the dealer CRM (UsedExportAll.csv) and works out what to do with it:
   which cars to add to prep, which cars already in the app to update, and which have dropped off the list.

   Only these columns are used. Costs, VIN, engine number and the rest are deliberately ignored, because they
   are not needed for prep and should not be visible to workshop logins:
     Vehicle Number, Registration Number, Vehicle Description, Colour Description, Last Odometer Reading,
     Adoption Date, Days in Stock, Branch Code, Manufacturer, Description, Progress Code, Selling Price */

const MAKES = ['Abarth', 'Alfa Romeo', 'Audi', 'BMW', 'BYD', 'Citroen', 'Cupra', 'Dacia', 'DS', 'Fiat', 'Ford', 'Genesis', 'Honda', 'Hyundai',
  'Jaguar', 'Jeep', 'Kia', 'Land Rover', 'Lexus', 'Mazda', 'Mercedes-Benz', 'Mercedes', 'MG', 'Mini', 'Mitsubishi', 'Nissan', 'Omoda',
  'Peugeot', 'Polestar', 'Porsche', 'Renault', 'Seat', 'Skoda', 'Smart', 'Subaru', 'Suzuki', 'Tesla', 'Toyota', 'Vauxhall',
  'Volkswagen', 'VW', 'Volvo'];
const SMALL_WORDS = /^(dr|tr|sr|gr|gt|gti|tdi|tsi|tfsi|hev|phev|ev|cvt|dct|vvt-i|d-4d|4wd|awd|ldn|r-line|st-line|n-line|amg|rs|se|sel|cdi|crdi|mhev|i)$/i;

// The CRM sends Windows text (e.g. ® as 0xAE). Use UTF-8 when the file really is UTF-8, otherwise Windows-1252.
function decode(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.slice(3).toString('utf8');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (e) { /* not UTF-8 */ }
  try { return new TextDecoder('windows-1252').decode(buf); } catch (e) { return buf.toString('latin1'); }
}

// A small CSV reader that copes with quoted fields, commas and line breaks inside quotes.
function parseCsv(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(f); f = ''; if (row.length > 1 || row[0] !== '') rows.push(row); row = [];
    } else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows;
}

const REG_CURRENT = /^[A-Z]{2}\d{2}[A-Z]{3}$/;
const normReg = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const fmtReg = (s) => (REG_CURRENT.test(s) ? s.slice(0, 4) + ' ' + s.slice(4) : s);
const ukDate = (s) => { const m = String(s || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); return m ? m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0') : ''; };
const int = (s) => { const n = parseInt(String(s || '').replace(/[^\d-]/g, ''), 10); return Number.isFinite(n) ? n : null; };

// "VOLKSWAGEN POLO MATCH TSI S-A" -> "Polo Match TSI S-A"; mixed-case text is left as the CRM wrote it.
function tidyWords(s) {
  s = String(s || '').trim().replace(/\s+/g, ' ');
  if (s !== s.toUpperCase()) return s;
  return s.split(' ').map((w) => (SMALL_WORDS.test(w) || /\d/.test(w) && w.length <= 4 ? w.toUpperCase() : w.charAt(0) + w.slice(1).toLowerCase())).join(' ');
}
function titleMake(m) {
  const hit = MAKES.find((x) => x.toLowerCase() === String(m || '').trim().toLowerCase());
  return hit || tidyWords(String(m || '').toUpperCase());
}
// Make and model. Franchise makes come from Manufacturer; non-franchise cars ("NONFRAN") carry the make in the description.
function makeModel(manufacturer, description) {
  let desc = tidyWords(description);
  let make = '';
  const man = String(manufacturer || '').trim();
  if (man && !/^nonfran/i.test(man)) make = titleMake(man);
  const lower = desc.toLowerCase();
  const inDesc = MAKES.slice().sort((a, b) => b.length - a.length).find((x) => lower === x.toLowerCase() || lower.startsWith(x.toLowerCase() + ' '));
  if (inDesc) { if (!make) make = inDesc === 'VW' ? 'Volkswagen' : inDesc; desc = desc.slice(inDesc.length).trim(); }
  if (!make && /^(yaris|aygo|corolla|c-hr|rav4|prius|auris|camry|land cruiser|hilux|proace|bz4x|supra|gr86|verso|avensis|iq|urban cruiser)\b/i.test(desc)) make = 'Toyota';
  if (/please enter|^tbc$|^to be confirmed$/i.test(desc)) desc = '';        // CRM placeholder, not a model
  return { make, model: desc.slice(0, 60) };
}
// "Pure White (Solid Paint)" -> "Pure White"
const tidyColour = (s) => tidyWords(String(s || '').replace(/\(.*?\)/g, '').trim()).slice(0, 40);

function rows(buf) { return rowsFromText(decode(buf)); }
function rowsFromText(text) {
  const table = parseCsv(text);
  if (!table.length) return [];
  const head = table[0].map((h) => h.trim().toLowerCase());
  const col = (name) => head.indexOf(name.toLowerCase());
  const need = ['Registration Number', 'Branch Code'];
  for (const n of need) if (col(n) < 0) throw new Error('This does not look like the CRM stock export: there is no "' + n + '" column.');
  const get = (r, n) => { const i = col(n); return i < 0 ? '' : String(r[i] == null ? '' : r[i]).trim(); };
  return table.slice(1).map((r) => {
    const mm = makeModel(get(r, 'Manufacturer'), get(r, 'Vehicle Description'));
    const reg = normReg(get(r, 'Registration Number'));
    return {
      stock: get(r, 'Vehicle Number'), reg, regShown: fmtReg(reg), make: mm.make, model: mm.model, colour: tidyColour(get(r, 'Colour Description')),
      mileage: int(get(r, 'Last Odometer Reading')), adoption: ukDate(get(r, 'Adoption Date')), daysInStock: int(get(r, 'Days in Stock')),
      branch: get(r, 'Branch Code'), kind: get(r, 'Description').replace(/\s*\(.*\)\s*$/, ''), progress: get(r, 'Progress Code'),
      price: int(get(r, 'Selling Price')) || null,
    };
  }).filter((r) => r.reg);
}

// Same branch whether written "42" or "0042".
const sameBranch = (a, b) => String(a || '').replace(/^0+/, '') === String(b || '').replace(/^0+/, '');

/* Work out the changes.
   cars: [{ id, data }] from the app.  opts: { branch, kinds: [..], progress: [..], firstRun, firstDays, seen: Set(stock numbers) }
   Returns { add: [row], update: [{ id, row }], missing: [id], back: [id], seen: [stock numbers], counts } */
function plan(all, cars, opts) {
  const mine = all.filter((r) => sameBranch(r.branch, opts.branch));
  const kinds = opts.kinds.map((k) => k.toLowerCase()), progress = opts.progress.map((p) => p.toLowerCase());
  const wanted = (r) => kinds.includes(r.kind.toLowerCase()) && progress.includes(r.progress.toLowerCase());
  const byReg = new Map(); for (const c of cars) byReg.set(normReg(c.data.reg), c);
  const add = [], update = [], seen = [], skippedOld = [], addedRegs = new Set();
  for (const r of mine) {
    if (addedRegs.has(r.reg)) continue;                       // the same registration twice in one file: one card only
    const car = byReg.get(r.reg);
    if (car) { update.push({ id: car.id, row: r }); if (wanted(r)) seen.push(r.stock || r.reg); continue; }
    if (!wanted(r)) continue;
    const key = r.stock || r.reg;
    seen.push(key);
    if (opts.seen.has(key)) continue;                         // already handled on an earlier day (or deleted from the app on purpose)
    if (opts.firstRun && opts.firstDays > 0 && !(r.daysInStock != null && r.daysInStock <= opts.firstDays)) { skippedOld.push(r.reg); continue; }
    add.push(r); addedRegs.add(r.reg);
  }
  // Cars that came from (or were matched to) this branch's CRM list, are still in prep, and are no longer on the list.
  const onList = new Set(mine.map((r) => r.reg));
  const missing = [], back = [];
  for (const c of cars) {
    const crm = c.data.crm;
    if (!crm || !sameBranch(crm.branch, opts.branch) || c.data.archived === true) continue;
    if (!onList.has(normReg(c.data.reg))) { if (!crm.missingSince) missing.push(c.id); }
    else if (crm.missingSince) back.push(c.id);
  }
  // Due in stock: this branch's cars whose date into stock is still in the future.
  const dueIn = opts.today ? mine.filter((r) => r.adoption && r.adoption > opts.today).sort((a, b) => (a.adoption < b.adoption ? -1 : a.adoption > b.adoption ? 1 : 0))
    .map((r) => ({ reg: r.regShown, make: r.make, model: r.model, colour: r.colour, mileage: r.mileage, adoption: r.adoption, kind: r.kind, progress: r.progress, stock: r.stock, price: r.price, onBoard: byReg.has(r.reg) ? byReg.get(r.reg).id : null })) : [];
  return { add, update, missing, back, seen, skippedOld, dueIn,
    counts: { rows: all.length, branch: mine.length, wanted: mine.filter(wanted).length } };
}

if (typeof module !== 'undefined') module.exports = { rows, rowsFromText, plan, decode, parseCsv, makeModel, tidyColour, normReg, sameBranch };
