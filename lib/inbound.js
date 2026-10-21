'use strict';
/* Reads car details out of an email body.
   Expected layout, one car per group of lines (price, TAC and service lines are ignored):

     AYGO X
     YB19CYZ
     TAG-184
     TAC
     SERVICE
     MOT
     MILEAGE- 58552
     PRICE – 8690
*/

const MAKES = ['Abarth', 'Alfa Romeo', 'Audi', 'BMW', 'Citroen', 'Cupra', 'Dacia', 'DS', 'Fiat', 'Ford', 'Honda', 'Hyundai', 'Jaguar', 'Jeep', 'Kia', 'Land Rover', 'Lexus', 'Mazda', 'Mercedes', 'Mercedes-Benz', 'MG', 'Mini', 'Mitsubishi', 'Nissan', 'Peugeot', 'Polestar', 'Porsche', 'Renault', 'Seat', 'Skoda', 'Smart', 'Subaru', 'Suzuki', 'Tesla', 'Toyota', 'Vauxhall', 'Volkswagen', 'VW', 'Volvo'];
// Used only when the email gives the model without the make.
const MODEL_MAKE = {
  aygo: 'Toyota', yaris: 'Toyota', corolla: 'Toyota', 'c-hr': 'Toyota', rav4: 'Toyota', 'gr yaris': 'Toyota', 'yaris cross': 'Toyota',
  fiesta: 'Ford', focus: 'Ford', puma: 'Ford', kuga: 'Ford', ecosport: 'Ford', mondeo: 'Ford',
  corsa: 'Vauxhall', astra: 'Vauxhall', mokka: 'Vauxhall', crossland: 'Vauxhall', grandland: 'Vauxhall',
  golf: 'Volkswagen', polo: 'Volkswagen', tiguan: 'Volkswagen', 't-roc': 'Volkswagen', passat: 'Volkswagen',
  qashqai: 'Nissan', juke: 'Nissan', micra: 'Nissan', leaf: 'Nissan',
  sportage: 'Kia', picanto: 'Kia', ceed: 'Kia', niro: 'Kia', stonic: 'Kia',
  i10: 'Hyundai', i20: 'Hyundai', i30: 'Hyundai', tucson: 'Hyundai', kona: 'Hyundai',
  clio: 'Renault', captur: 'Renault', megane: 'Renault',
  '208': 'Peugeot', '2008': 'Peugeot', '3008': 'Peugeot', '308': 'Peugeot',
  jazz: 'Honda', civic: 'Honda', 'cr-v': 'Honda', 'hr-v': 'Honda',
  swift: 'Suzuki', vitara: 'Suzuki', ignis: 'Suzuki',
  ibiza: 'Seat', leon: 'Seat', arona: 'Seat',
  fabia: 'Skoda', octavia: 'Skoda', kamiq: 'Skoda', karoq: 'Skoda',
  a1: 'Audi', a3: 'Audi', a4: 'Audi', q2: 'Audi', q3: 'Audi', q5: 'Audi',
};

const KEYWORD = /^(tag|tac|service|mot|mileage|miles|price|colour|color)\b/i;
const REG_CURRENT = /^[A-Z]{2}\d{2}[A-Z]{3}$/;
const REG_OLD = /^([A-Z]\d{1,3}[A-Z]{3}|[A-Z]{3}\d{1,3}[A-Z])$/;

function regOf(line) {
  const s = line.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (REG_CURRENT.test(s) || REG_OLD.test(s)) return s;
  return null;
}
function fmtReg(s) { return REG_CURRENT.test(s) ? s.slice(0, 4) + ' ' + s.slice(4) : s; }
function normReg(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }

function niceWord(w) { return w.length <= 3 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(); }
function niceModel(s) { return s.split(/(\s+)/).map((w) => (/^\s+$/.test(w) ? w : (w === w.toUpperCase() || w === w.toLowerCase() ? niceWord(w) : w))).join(''); }

function splitMake(line) {
  const low = line.toLowerCase();
  const hit = MAKES.filter((m) => low === m.toLowerCase() || low.startsWith(m.toLowerCase() + ' ')).sort((a, b) => b.length - a.length)[0];
  if (hit) return { make: hit === 'VW' ? 'Volkswagen' : hit, model: line.slice(hit.length).trim() };
  const key = low.trim();
  const first = low.split(/\s+/)[0];
  const guess = MODEL_MAKE[key] || MODEL_MAKE[first];
  return { make: guess || '', model: line.trim() };
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h\d)[^>]*>/gi, '\n')
    .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"');
}

function parseMot(line) {
  const m = line.match(/\b(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2}|\d{4})\b/);
  if (!m) return '';
  let [, d, mo, y] = m; d = +d; mo = +mo; y = +y; if (y < 100) y += 2000;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return '';
  return y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

function parseCars(text) {
  const lines = String(text || '').split(/\r?\n/)
    .map((l) => l.replace(/^[\s>*•\-–]+(?=\S)/, (m) => (/^\s*[-–]\s*$/.test(m) ? m : '')).replace(/^[\s>]+/, '').trim())
    .filter(Boolean);
  const regIdx = [];
  lines.forEach((l, i) => { if (regOf(l.replace(/^reg(istration)?\s*[:\-–]?\s*/i, ''))) regIdx.push(i); });
  const cars = [];
  regIdx.forEach((i, n) => {
    const reg = regOf(lines[i].replace(/^reg(istration)?\s*[:\-–]?\s*/i, ''));
    const prev = i > 0 ? lines[i - 1] : '';
    const hasModel = prev && !KEYWORD.test(prev) && !regOf(prev) && /^[A-Za-z0-9 .\/+&'-]{2,40}$/.test(prev) && !(n > 0 && regIdx[n - 1] === i - 1);
    const next = regIdx[n + 1];
    const nextPrevIsModel = next !== undefined && next - 1 > i && !KEYWORD.test(lines[next - 1]);
    const end = next === undefined ? lines.length : (nextPrevIsModel ? next - 1 : next);
    const body = lines.slice(i + 1, end);
    let tag = '', mileage = null, mot = '';
    const want = new Set();
    body.forEach((l) => {
      let m;
      // A MOT line with a date is the car's existing MOT expiry, so MOT is not requested. A bare MOT line is a request.
      (l.toUpperCase().match(/\b(TAC|SERVICE|MOT)\b/g) || []).forEach((w) => { if (!(w === 'MOT' && parseMot(l))) want.add(w); });
      if (!tag && (m = l.match(/^tag\s*[-:#]?\s*([A-Za-z0-9-]+)/i))) tag = 'TAG-' + m[1].replace(/^tag-?/i, '').toUpperCase();
      if (mileage === null && (m = l.match(/^(mileage|miles)\s*[-–—:=.]*\s*([\d,]+)/i))) mileage = parseInt(m[2].replace(/,/g, ''), 10);
      if (!mot && /^mot\b/i.test(l)) mot = parseMot(l);
    });
    const { make, model } = hasModel ? splitMake(prev) : { make: '', model: '' };
    const prep = ['TAC', 'SERVICE', 'MOT'].filter((w) => want.has(w));
    cars.push({ reg: fmtReg(reg), make: niceModel(make), model: niceModel(model), tag, mileage, mot, prep });
  });
  return cars;
}

function emailText(b) {
  const t = b.text || b.TextBody || b['body-plain'] || b.plain || b.body || b.content || '';
  if (String(t).trim()) return String(t);
  return htmlToText(b.html || b.HtmlBody || b['body-html'] || '');
}
function emailSender(b) {
  let s = b.from || b.From || b.sender || b.Sender || (b.FromFull && b.FromFull.Email) || '';
  if (typeof s === 'object' && s) s = s.email || s.address || s.Email || '';
  s = String(s);
  const m = s.match(/<([^>]+)>/);
  return (m ? m[1] : s).trim().toLowerCase();
}

module.exports = { parseCars, emailText, emailSender, normReg };
