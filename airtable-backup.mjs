#!/usr/bin/env node
// airtable-backup: export every table of an Airtable base to CSV, save the schema,
// and optionally download attachment files. Zero dependencies, Node 18+.
//
//   AIRTABLE_TOKEN=... node airtable-backup.mjs --base appXXXXXXXXXXXXXX [--out dir] [--attachments] [--safe]
//
// Copyright (c) 2026 ViewCourier - MIT License

import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

const API = () => (process.env.AIRTABLE_API_URL || 'https://api.airtable.com').replace(/\/+$/, '');
const MIN_INTERVAL_MS = Number(process.env.AIRTABLE_MIN_INTERVAL_MS || 220); // about 4.5 requests per second
const RETRY_WAIT_MS = process.env.AIRTABLE_RETRY_WAIT_MS ? Number(process.env.AIRTABLE_RETRY_WAIT_MS) : 30000;
const MAX_RETRIES = 6;
const DOWNLOAD_CONCURRENCY = 4;

const HELP = `Usage: node airtable-backup.mjs --base appXXXXXXXXXXXXXX [options]

Exports every table of an Airtable base to CSV and saves the base schema.
The token is read from the AIRTABLE_TOKEN environment variable
(scopes: data.records:read, schema.bases:read).

Options:
  --base <id>        Base ID (starts with "app"). Required.
  --out <dir>        Output directory. Default: ./airtable-backup-<base>
  --attachments      Also download attachment files to <out>/attachments/<table>/
  --safe             Neutralise spreadsheet formulas: text starting with = + - @ gets a leading '
  --table <name|id>  Only export this table (repeatable). Default: all tables
  --bom              Start CSV files with a UTF-8 byte order mark (helps Excel)
  -h, --help         Show this help
`;

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** RFC 4180 field: quote when it holds a comma, quote, CR or LF; double inner quotes. */
export function csvField(text) {
  const s = String(text);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** One CSV line without the line break. */
export function csvLine(cells) {
  return cells.map(csvField).join(',');
}

/** Prefix text that spreadsheets would run as a formula (OWASP CSV injection guidance). */
export function neutralise(text) {
  return /^[=+\-@\t\r]/.test(text) ? "'" + text : text;
}

/** Make a string safe to use as a single file or directory name on Windows, macOS and Linux. */
export function safeName(name, fallback = 'unnamed') {
  let s = String(name).normalize('NFC').replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_').replace(/^\.+/, '_').replace(/[ .]+$/, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(s)) s = '_' + s;
  if (s.length > 120) {
    const ext = path.extname(s).slice(0, 20);
    s = s.slice(0, 120 - ext.length) + ext;
  }
  return s || fallback;
}

const isAttachment = (v) => v && typeof v === 'object' && typeof v.url === 'string' && typeof v.id === 'string' && 'filename' in v;

/**
 * Turn one Airtable cell value into CSV text.
 *  - numbers, booleans: as is; empty: ''
 *  - arrays of text/numbers (multiple select, linked record IDs, lookups): joined with ", "
 *  - attachments: "filename (url)" per file, one per line; with `attachmentPaths`, the local path instead
 *  - collaborators: "Name <email>"; buttons: "label (url)"
 *  - other objects and arrays of objects: JSON
 */
export function cellText(value, { attachmentPaths } = {}) {
  if (value === null || value === undefined) return { text: '', literal: true };
  if (typeof value === 'number' || typeof value === 'boolean') return { text: String(value), literal: true };
  if (typeof value === 'string') return { text: value, literal: false };
  if (Array.isArray(value)) {
    if (value.length && value.every(isAttachment)) {
      const lines = value.map((a) => (attachmentPaths && attachmentPaths.get(a.id)) || `${a.filename} (${a.url})`);
      return { text: lines.join('\n'), literal: false };
    }
    if (value.every((v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) {
      return { text: value.join(', '), literal: false };
    }
    return { text: value.map((v) => cellText(v, { attachmentPaths }).text).join('\n'), literal: false };
  }
  if (typeof value === 'object') {
    if (typeof value.email === 'string' && typeof value.id === 'string') {
      return { text: value.name ? `${value.name} <${value.email}>` : value.email, literal: false };
    }
    if (typeof value.url === 'string' && typeof value.label === 'string') return { text: `${value.label} (${value.url})`, literal: false };
    if ('specialValue' in value) return { text: String(value.specialValue), literal: false };
    if (typeof value.error === 'string') return { text: value.error, literal: false };
    return { text: JSON.stringify(value), literal: false };
  }
  return { text: String(value), literal: false };
}

/** Column names for a table: record ID, created time, then every schema field in schema order. */
export function tableColumns(table) {
  const names = table.fields.map((f) => f.name);
  let idCol = '_recordId';
  let createdCol = '_createdTime';
  while (names.includes(idCol)) idCol += '_';
  while (names.includes(createdCol)) createdCol += '_';
  return { idCol, createdCol, fieldNames: names, header: [idCol, createdCol, ...names] };
}

/** CSV row (array of strings) for one record. */
export function recordRow(record, columns, { safe = false, attachmentPaths } = {}) {
  const cells = [record.id, record.createdTime || ''];
  for (const name of columns.fieldNames) {
    const { text, literal } = cellText(record.fields ? record.fields[name] : undefined, { attachmentPaths });
    cells.push(safe && !literal ? neutralise(text) : text);
  }
  return cells;
}

/** Assign unique names within one directory (case-insensitive), appending _2, _3, ... on clashes. */
export function uniqueName(used, wanted) {
  let candidate = wanted;
  const ext = path.extname(wanted);
  const stem = ext ? wanted.slice(0, -ext.length) : wanted;
  for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${stem}_${n}${ext}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

// ---------------------------------------------------------------------------
// HTTP: rate limit + retry
// ---------------------------------------------------------------------------

let nextSlot = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Space API requests at least MIN_INTERVAL_MS apart (Airtable allows 5 per second per base). */
async function throttle() {
  const now = Date.now();
  const slot = Math.max(now, nextSlot);
  nextSlot = slot + MIN_INTERVAL_MS;
  if (slot > now) await sleep(slot - now);
}

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function explain(status, bodyText, what) {
  let detail = '';
  try { const j = JSON.parse(bodyText); detail = (j.error && (j.error.message || j.error.type)) || String(j.error || ''); } catch { detail = bodyText.slice(0, 200); }
  let hint = '';
  if (status === 401) hint = ' Check AIRTABLE_TOKEN.';
  else if (status === 403) hint = ' The token needs data.records:read and schema.bases:read and access to this base.';
  else if (status === 404) hint = ' Check the base ID.';
  return `${what}: HTTP ${status}${detail ? ' - ' + detail : ''}.${hint}`;
}

/** GET an Airtable API path with throttling and retry on 429/5xx. Returns parsed JSON. */
export async function apiGet(token, pathAndQuery, what = 'request') {
  for (let attempt = 0; ; attempt++) {
    await throttle();
    let res;
    try {
      res = await fetch(API() + pathAndQuery, { headers: { Authorization: `Bearer ${token}` } });
    } catch (err) {
      if (attempt < MAX_RETRIES) { await sleep(Math.min(1000 * 2 ** attempt, 15000)); continue; }
      throw new Error(`${what}: network error: ${err.message}`);
    }
    const body = await res.text();
    if (res.ok) return JSON.parse(body);
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
      const ra = Number(res.headers.get('retry-after'));
      const wait = RETRY_WAIT_MS === 0 ? 0 : ra > 0 ? ra * 1000 : res.status === 429 ? RETRY_WAIT_MS : Math.min(1000 * 2 ** attempt, 15000);
      log(`  ${what}: HTTP ${res.status}, retrying in ${Math.round(wait / 1000)} s (${attempt + 1}/${MAX_RETRIES})`);
      await sleep(wait);
      continue;
    }
    throw new ApiError(res.status, explain(res.status, body, what));
  }
}

function log(msg) { process.stderr.write(msg + '\n'); }

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

async function downloadFile(url, dest) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.permanent = res.status >= 400 && res.status < 500 && res.status !== 429; throw e; }
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
      return;
    } catch (err) {
      fs.rmSync(dest, { force: true });
      if (attempt >= 2 || err.permanent) throw err;
      await sleep(1000 * (attempt + 1));
    }
  }
}

/** Run async `worker` over `items` with at most `limit` in flight. */
async function pool(items, limit, worker) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await worker(items[i++]);
  }));
}

export async function exportBase({ token, base, out, attachments = false, safe = false, only = [], bom = false }) {
  fs.mkdirSync(out, { recursive: true });
  const meta = await apiGet(token, `/v0/meta/bases/${encodeURIComponent(base)}/tables`, 'schema');
  fs.writeFileSync(path.join(out, 'schema.json'), JSON.stringify(meta, null, 2) + '\n');
  let tables = meta.tables;
  if (only.length) {
    tables = tables.filter((t) => only.includes(t.name) || only.includes(t.id));
    if (!tables.length) throw new Error(`No table matches ${only.join(', ')}. Tables in this base: ${meta.tables.map((t) => t.name).join(', ')}`);
  }
  log(`Base ${base}: ${tables.length} table(s)`);

  const usedFiles = new Set();
  const manifest = { base, exportedAt: new Date().toISOString(), tables: [], attachmentFailures: [] };
  for (const table of tables) {
    const file = uniqueName(usedFiles, safeName(table.name, table.id) + '.csv');
    const csvPath = path.join(out, file);
    const columns = tableColumns(table);
    const BOM = bom ? '\uFEFF' : '';
    fs.writeFileSync(csvPath, BOM + csvLine(columns.header) + '\r\n');

    const attDir = path.join(out, 'attachments', safeName(table.name, table.id));
    const usedAtt = new Set();
    let records = 0, files = 0, bytes = 0;
    let offset = '';
    do {
      const q = new URLSearchParams({ pageSize: '100' });
      if (offset) q.set('offset', offset);
      const page = await apiGet(token, `/v0/${encodeURIComponent(base)}/${encodeURIComponent(table.id)}?${q}`, `table "${table.name}"`);

      // Attachment URLs expire after about 2 hours, so download them as soon as each page arrives.
      const attachmentPaths = new Map();
      if (attachments) {
        const jobs = [];
        for (const rec of page.records) {
          for (const value of Object.values(rec.fields || {})) {
            if (!Array.isArray(value) || !value.length || !value.every(isAttachment)) continue;
            for (const att of value) {
              const name = uniqueName(usedAtt, safeName(`${rec.id}_${att.filename}`));
              const rel = path.posix.join('attachments', safeName(table.name, table.id), name);
              attachmentPaths.set(att.id, rel);
              jobs.push({ att, rec, name, rel });
            }
          }
        }
        if (jobs.length) fs.mkdirSync(attDir, { recursive: true });
        await pool(jobs, DOWNLOAD_CONCURRENCY, async (job) => {
          const dest = path.join(attDir, job.name);
          try {
            await downloadFile(job.att.url, dest);
            files++; bytes += fs.statSync(dest).size;
          } catch (err) {
            attachmentPaths.delete(job.att.id);
            manifest.attachmentFailures.push({ table: table.name, record: job.rec.id, file: job.att.filename, error: err.message });
            log(`  could not download ${job.att.filename} (${job.rec.id}): ${err.message}`);
          }
        });
      }

      const lines = page.records.map((rec) => csvLine(recordRow(rec, columns, { safe, attachmentPaths })) + '\r\n');
      fs.appendFileSync(csvPath, lines.join(''));
      records += page.records.length;
      offset = page.offset || '';
    } while (offset);

    log(`  ${table.name}: ${records} records -> ${file}` + (attachments ? `, ${files} attachment file(s)` : ''));
    manifest.tables.push({ id: table.id, name: table.name, file, records, ...(attachments ? { attachmentFiles: files, attachmentBytes: bytes } : {}) });
  }
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(argv) {
  let args;
  try {
    args = parseArgs({
      args: argv,
      options: {
        base: { type: 'string' }, out: { type: 'string' }, attachments: { type: 'boolean', default: false },
        safe: { type: 'boolean', default: false }, table: { type: 'string', multiple: true }, bom: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    }).values;
  } catch (err) {
    log(err.message + '\n\n' + HELP);
    return 2;
  }
  if (args.help) { process.stdout.write(HELP); return 0; }
  const token = process.env.AIRTABLE_TOKEN;
  if (!args.base || !/^app[A-Za-z0-9]{10,}$/.test(args.base)) { log('Pass a base ID with --base appXXXXXXXXXXXXXX\n\n' + HELP); return 2; }
  if (!token) { log('Set the AIRTABLE_TOKEN environment variable.'); return 2; }
  const out = path.resolve(args.out || `airtable-backup-${args.base}`);
  try {
    const manifest = await exportBase({ token, base: args.base, out, attachments: args.attachments, safe: args.safe, only: args.table || [], bom: args.bom });
    const total = manifest.tables.reduce((n, t) => n + t.records, 0);
    log(`Done: ${manifest.tables.length} table(s), ${total} records -> ${out}`);
    if (manifest.attachmentFailures.length) { log(`${manifest.attachmentFailures.length} attachment download(s) failed, see manifest.json`); return 3; }
    return 0;
  } catch (err) {
    log('Error: ' + err.message);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
