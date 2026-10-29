#!/usr/bin/env node
// Checks a finished backup against the live Airtable API, with its own paging and its own CSV parser
// (it shares no code with airtable-backup.mjs):
//   - schema.json lists every table of the base and every field
//   - every table has a CSV whose data row count equals the number of records the API returns
//   - every record ID in the API appears exactly once in the CSV
//   - every CSV row has the same number of columns as the header
//   - with --attachments: every attachment in the API has a file in out/attachments/<table>/
//
//   AIRTABLE_TOKEN=... node test/verify.mjs --base appXXXXXXXXXXXXXX --out <backup dir> [--attachments]

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({ options: { base: { type: 'string' }, out: { type: 'string' }, attachments: { type: 'boolean', default: false } } });
const token = process.env.AIRTABLE_TOKEN;
if (!args.base || !args.out || !token) { console.error('Need --base, --out and AIRTABLE_TOKEN'); process.exit(2); }

async function get(url) {
  for (let i = 0; i < 8; i++) {
    const res = await fetch('https://api.airtable.com' + url, { headers: { Authorization: 'Bearer ' + token } });
    if (res.ok) return res.json();
    if (res.status === 429 || res.status >= 500) { await new Promise((r) => setTimeout(r, 30000)); continue; }
    throw new Error(url + ' -> HTTP ' + res.status);
  }
  throw new Error('gave up on ' + url);
}

/** Minimal RFC 4180 parser: handles quoted fields, doubled quotes, CRLF/LF inside quotes. */
function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = []; let row = []; let field = ''; let i = 0; let quoted = false;
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } quoted = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"') { quoted = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r' && text[i + 1] === '\n') { row.push(field); rows.push(row); row = []; field = ''; i += 2; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (quoted) throw new Error('unterminated quote');
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const problems = [];
const check = (ok, msg) => { if (!ok) problems.push(msg); };

const meta = await get(`/v0/meta/bases/${args.base}/tables`);
const schema = JSON.parse(fs.readFileSync(path.join(args.out, 'schema.json'), 'utf8'));
check(schema.tables.length === meta.tables.length, `schema.json has ${schema.tables.length} tables, API has ${meta.tables.length}`);
for (const t of meta.tables) {
  const s = schema.tables.find((x) => x.id === t.id);
  check(s && s.name === t.name && s.fields.length === t.fields.length, `schema.json missing or different for table ${t.name}`);
}
const manifest = JSON.parse(fs.readFileSync(path.join(args.out, 'manifest.json'), 'utf8'));

let totalRecords = 0, totalRows = 0, totalAtt = 0, foundAtt = 0;
for (const t of meta.tables) {
  const ids = []; let offset = ''; const attFiles = [];
  do {
    const page = await get(`/v0/${args.base}/${t.id}?pageSize=100${offset ? '&offset=' + encodeURIComponent(offset) : ''}`);
    for (const r of page.records) {
      ids.push(r.id);
      for (const v of Object.values(r.fields)) if (Array.isArray(v) && v.length && v.every((a) => a && a.url && a.filename)) attFiles.push(...v.map((a) => ({ rec: r.id, name: a.filename })));
    }
    offset = page.offset || '';
  } while (offset);

  const entry = manifest.tables.find((x) => x.id === t.id);
  check(entry, `manifest has no entry for ${t.name}`);
  if (!entry) continue;
  const rows = parseCsv(fs.readFileSync(path.join(args.out, entry.file), 'utf8'));
  const header = rows[0];
  const data = rows.slice(1);
  check(header.length === t.fields.length + 2, `${t.name}: header has ${header.length} columns, expected ${t.fields.length + 2}`);
  for (const f of t.fields) check(header.includes(f.name), `${t.name}: column ${f.name} missing`);
  check(data.every((r) => r.length === header.length), `${t.name}: ragged rows`);
  check(data.length === ids.length, `${t.name}: CSV has ${data.length} rows, API has ${ids.length} records`);
  check(entry.records === ids.length, `${t.name}: manifest says ${entry.records}`);
  const csvIds = data.map((r) => r[0]);
  check(new Set(csvIds).size === csvIds.length && ids.every((id) => csvIds.includes(id)), `${t.name}: record IDs differ`);
  totalRecords += ids.length; totalRows += data.length;

  if (args.attachments) {
    const dir = path.join(args.out, 'attachments', t.name);
    for (const a of attFiles) {
      totalAtt++;
      const exists = fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.startsWith(a.rec + '_'));
      if (exists) foundAtt++;
      check(exists, `${t.name}: attachment ${a.name} of ${a.rec} not downloaded`);
    }
  }
  console.log(`  ${t.name}: API ${ids.length} records, CSV ${data.length} rows, ${header.length} columns${args.attachments ? ', attachments ' + attFiles.length : ''}`);
}
console.log(`${args.base}: tables API=${meta.tables.length} schema.json=${schema.tables.length}; records API=${totalRecords} CSV=${totalRows}` + (args.attachments ? `; attachments API=${totalAtt} on disk=${foundAtt}` : ''));
if (problems.length) { console.log('FAIL'); problems.forEach((p) => console.log(' - ' + p)); process.exit(1); }
console.log('PASS');
