'use strict';
/* The daily prep snapshot email: a short summary of every car in prep, built from the same rules as the board. */

const TARGET = 7;
const STAGES = [
  ['arrived', 'Inbound', ['advert', 'lines', 'qr']], ['valet', 'Valet', ['done']], ['photos', 'Photos', ['done']],
  ['mech', 'Mechanical', ['pt145', 'service', 'motbook', 'qc']], ['body', 'Bodywork', ['cosmetic', 'dent', 'wheels', 'paint', 'qc']],
  ['ready', 'Quality Check', ['qc']],
];
const JOBS = [['body_dent', 'Dents'], ['body_wheels', 'Alloy wheels'], ['body_paint', 'Paint']];
const LABEL = Object.fromEntries(STAGES.map((s) => [s[0], s[1]]));

const dayNum = (s) => Math.floor(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 86400000);
const fromDay = (n) => new Date(n * 86400000).toISOString().slice(0, 10);
const nice = (s) => new Date(s + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const stageDone = (c, s) => s[2].every((t) => (c.done || {})[s[0] + '_' + t] === true);
const stageKey = (c) => { const s = STAGES.find((x) => !stageDone(c, x)); return s ? s[0] : 'ready'; };
const isDone = (c) => (c.done || {}).ready_qc === true && stageKey(c) === 'ready';
function isArchived(c, today) {
  if (c.archived === true) return true;
  if (c.archived === false) return false;
  if (c.readyAt && isDone(c) && today - dayNum(c.readyAt) > 30) return true;
  return !!c.added && today - dayNum(c.added) > 365;
}
const carName = (c) => [c.make, c.model].filter(Boolean).join(' ');

function build(cars, todayStr, opts) {
  const o = opts || {};
  const today = dayNum(todayStr);
  const live = cars.filter((c) => !isArchived(c, today));
  const prep = live.filter((c) => !isDone(c));
  const days = (c) => Math.max(0, (isDone(c) && c.readyAt ? dayNum(c.readyAt) : today) - dayNum(c.added || todayStr));
  // Completed since the last working day: on Monday that covers Friday to Sunday.
  const back = new Date(todayStr + 'T12:00:00Z').getUTCDay() === 1 ? 3 : 1;
  const since = today - back;
  const doneRecent = live.filter((c) => isDone(c) && c.readyAt && dayNum(c.readyAt) >= since && dayNum(c.readyAt) < today);
  const arrivedRecent = cars.filter((c) => c.added && dayNum(c.added) >= since && dayNum(c.added) < today);
  const over = prep.filter((c) => days(c) > TARGET).sort((a, b) => days(b) - days(a));
  const awaitingQc = prep.filter((c) => stageKey(c) === 'ready');
  const dept = STAGES.map((s) => [s[1], s[0] === 'ready' ? awaitingQc.length : prep.filter((c) => !stageDone(c, s)).length]);
  const jobs = JOBS.map((j) => [j[1], prep.filter((c) => (c.done || {})[j[0]] !== true).length]);
  const sixMonths = (() => { const d = new Date(todayStr + 'T12:00:00Z'); const day = d.getUTCDate(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + 6); const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(); d.setUTCDate(Math.min(day, last)); return d.toISOString().slice(0, 10); })();
  const motSoon = prep.filter((c) => /^\d{4}-\d{2}-\d{2}$/.test(c.mot || '') && c.mot <= sixMonths && (c.done || {}).mech_motbook !== true).sort((a, b) => a.mot.localeCompare(b.mot));
  const avg = prep.length ? Math.round(prep.reduce((n, c) => n + days(c), 0) / prep.length * 10) / 10 : 0;
  const period = back === 3 ? 'Fri to Sun' : nice(fromDay(since));

  const subject = (o.centre ? o.centre + ' ' : '') + 'Prep snapshot ' + nice(todayStr) + ': ' + prep.length + ' in prep, ' + over.length + ' over ' + TARGET + ' days';
  const row = (c, extra) => ({ reg: c.reg || '', tag: c.tag || '', name: carName(c), extra });

  const lists = [
    ['Over the ' + TARGET + ' day target', over.map((c) => row(c, days(c) + ' days, at ' + LABEL[stageKey(c)])), 'None. Every car is within target.'],
    ['Waiting for Quality Check', awaitingQc.map((c) => row(c, days(c) + ' days')), 'None.'],
    ['Completed (' + period + ')', doneRecent.map((c) => row(c, days(c) + ' days to complete')), 'None.'],
    ['MOT due (runs out within 6 months)', motSoon.map((c) => row(c, 'MOT ' + nice(c.mot) + ' ' + c.mot.slice(0, 4) + (dayNum(c.mot) < today ? ' (expired)' : '') + ((c.prep || []).includes('MOT') ? '' : ', MOT not ticked'))), 'None.'],
  ];

  // Plain text
  let text = subject + '\n\n'
    + 'In prep: ' + prep.length + '   Average days in prep: ' + avg + '   Over ' + TARGET + ' days: ' + over.length + '\n'
    + 'Arrived (' + period + '): ' + arrivedRecent.length + '   Completed (' + period + '): ' + doneRecent.length + '\n\n'
    + 'Still to do, by department\n' + dept.map((d) => '  ' + d[0] + ': ' + d[1]).join('\n') + '\n'
    + '  Bodywork jobs: ' + jobs.map((j) => j[0] + ' ' + j[1]).join(', ') + '\n';
  lists.forEach((l) => {
    text += '\n' + l[0] + ' (' + l[1].length + ')\n' + (l[1].length ? l[1].map((r) => '  ' + r.reg + (r.tag ? ' ' + r.tag : '') + '  ' + r.name + '  ' + r.extra).join('\n') : '  ' + l[2]) + '\n';
  });
  if (o.url) text += '\nOpen 145 Prepped: ' + o.url + '\n';

  // HTML (inline styles so it looks right in Outlook and Gmail)
  const navy = '#14284B', muted = '#5B6B82', line = '#E3E8EF', bad = '#B4281F';
  const tile = (n, l, warn) => '<td style="padding:6px"><div style="border:1px solid ' + line + ';border-radius:12px;padding:12px 14px;background:#fff">'
    + '<div style="font-size:26px;font-weight:700;color:' + (warn && n ? bad : navy) + '">' + n + '</div><div style="font-size:13px;color:' + muted + '">' + esc(l) + '</div></div></td>';
  const plate = (r) => '<span style="display:inline-block;background:#FFD500;color:#111;font-weight:700;border-radius:4px;padding:1px 6px;font-family:Arial,sans-serif;font-size:13px;letter-spacing:.5px">' + esc(r.reg) + '</span>';
  const table = (rows, empty) => rows.length
    ? '<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse">' + rows.map((r) => '<tr>'
      + '<td style="padding:7px 8px 7px 0;border-top:1px solid ' + line + ';white-space:nowrap">' + plate(r) + '</td>'
      + '<td style="padding:7px 8px;border-top:1px solid ' + line + ';color:' + muted + ';white-space:nowrap">' + esc(r.tag) + '</td>'
      + '<td style="padding:7px 8px;border-top:1px solid ' + line + '">' + esc(r.name) + '</td>'
      + '<td style="padding:7px 0 7px 8px;border-top:1px solid ' + line + ';text-align:right;color:' + muted + '">' + esc(r.extra) + '</td></tr>').join('') + '</table>'
    : '<p style="margin:4px 0;color:' + muted + '">' + esc(empty) + '</p>';
  const section = (h, body) => '<h2 style="font-size:16px;color:' + navy + ';margin:22px 0 6px">' + h + '</h2>' + body;

  const html = '<!doctype html><html><body style="margin:0;background:#F3F5F9;font-family:Segoe UI,Arial,sans-serif;color:#1B2433">'
    + '<div style="max-width:680px;margin:0 auto;padding:20px 14px">'
    + '<div style="background:' + navy + ';color:#fff;border-radius:14px;padding:18px 20px"><div style="font-size:13px;opacity:.8">' + esc(o.centre || '145 Prepped') + '</div>'
    + '<div style="font-size:22px;font-weight:700;margin-top:2px">Prep snapshot, ' + esc(nice(todayStr)) + '</div></div>'
    + '<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin-top:10px"><tr>'
    + tile(prep.length, 'In prep') + tile(over.length, 'Over ' + TARGET + ' days', true) + tile(awaitingQc.length, 'Awaiting QC') + tile(doneRecent.length, 'Completed ' + period)
    + '</tr></table>'
    + '<p style="color:' + muted + ';margin:6px 6px 0;font-size:14px">Average ' + avg + ' days in prep. ' + arrivedRecent.length + ' arrived (' + esc(period) + ').</p>'
    + '<div style="background:#fff;border:1px solid ' + line + ';border-radius:14px;padding:4px 18px 16px;margin-top:14px">'
    + section('Still to do, by department', '<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse">'
      + dept.map((d) => '<tr><td style="padding:6px 0;border-top:1px solid ' + line + '">' + esc(d[0]) + '</td><td style="padding:6px 0;border-top:1px solid ' + line + ';text-align:right;font-weight:700">' + d[1] + '</td></tr>').join('')
      + '<tr><td style="padding:6px 0;border-top:1px solid ' + line + ';color:' + muted + '">Bodywork jobs</td><td style="padding:6px 0;border-top:1px solid ' + line + ';text-align:right;color:' + muted + '">' + jobs.map((j) => esc(j[0]) + ' ' + j[1]).join(' &middot; ') + '</td></tr></table>')
    + lists.map((l) => section(esc(l[0]) + ' <span style="color:' + muted + ';font-weight:400">(' + l[1].length + ')</span>', table(l[1], l[2]))).join('')
    + '</div>'
    + (o.url ? '<p style="text-align:center;margin:18px 0"><a href="' + esc(o.url) + '" style="display:inline-block;background:' + navy + ';color:#fff;text-decoration:none;font-weight:700;border-radius:999px;padding:12px 26px">Open 145 Prepped</a></p>' : '')
    + '<p style="color:' + muted + ';font-size:12px;text-align:center">Sent automatically by 145 Prepped. An administrator can change who receives this under Account &rarr; Daily prep email.</p>'
    + '</div></body></html>';

  return { subject, text, html, counts: { inPrep: prep.length, over: over.length, awaitingQc: awaitingQc.length, completed: doneRecent.length } };
}

module.exports = { build };
