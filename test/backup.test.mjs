// Run: node --test test/        (Node 18+, no dependencies)
// Unit tests for the CSV/flattening helpers plus an end-to-end run against a local mock of the Airtable API
// (pagination, 429 retry, attachment download, name clashes, --safe). The mock is for behaviour that the
// real demo bases cannot show (they hold no attachments); the real-API check is test/e2e.mjs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', 'airtable-backup.mjs');
// The module reads these when it is imported, so set them first.
process.env.AIRTABLE_RETRY_WAIT_MS = '10'; // do not wait 30 s for the mocked 429

// ---------------------------------------------------------------- mock Airtable API
const BASE = 'appTEST0000000000';
const TOKEN = 'mock-token';
const requests = []; // { at, url, auth }
let server, port, tmp;
let throttled429 = 0;

const projectRecords = Array.from({ length: 250 }, (_, i) => ({
  id: 'recP' + String(i).padStart(4, '0'),
  createdTime: '2026-01-01T00:00:00.000Z',
  fields: {
    Name: i === 0 ? 'Quote " and, comma' : i === 1 ? 'Line one\nLine two' : i === 2 ? '=HYPERLINK("http://example.com")' : i === 3 ? 'Zoë – 日本語' : 'Project ' + i,
    Hours: i === 4 ? -2.5 : i,
    Done: i % 2 === 0 ? true : undefined,
    Tags: i === 5 ? ['a', 'b, c'] : undefined,
    Owner: i === 6 ? { id: 'usrAAA', email: 'sam@example.com', name: 'Sam' } : undefined,
    Memo: i === 7 ? '@SUM(1)' : i === 8 ? '+1 555 0100' : undefined,
  },
}));
for (const r of projectRecords) for (const k of Object.keys(r.fields)) if (r.fields[k] === undefined) delete r.fields[k];

const FILES = {
  '/files/a.pdf': Buffer.from('%PDF-1.4 fake pdf bytes\n'),
  '/files/b.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 255]),
  '/files/c.txt': Buffer.from('same name 1'),
  '/files/d.txt': Buffer.from('same name 2'),
  '/files/e.txt': Buffer.from('evil'),
};
const fileRecords = () => [
  { id: 'recF0001', createdTime: '2026-01-01T00:00:00.000Z', fields: { Title: 'Two files', Files: [
    { id: 'attA', url: `http://127.0.0.1:${port}/files/a.pdf`, filename: 'report.pdf', size: FILES['/files/a.pdf'].length, type: 'application/pdf' },
    { id: 'attB', url: `http://127.0.0.1:${port}/files/b.png`, filename: 'logo.png', size: FILES['/files/b.png'].length, type: 'image/png' } ] } },
  { id: 'recF0002', createdTime: '2026-01-01T00:00:00.000Z', fields: { Title: 'Clashing names', Files: [
    { id: 'attC', url: `http://127.0.0.1:${port}/files/c.txt`, filename: 'notes.txt', size: 11, type: 'text/plain' },
    { id: 'attD', url: `http://127.0.0.1:${port}/files/d.txt`, filename: 'notes.txt', size: 11, type: 'text/plain' },
    { id: 'attE', url: `http://127.0.0.1:${port}/files/e.txt`, filename: '../../evil.txt', size: 4, type: 'text/plain' } ] } },
  { id: 'recF0003', createdTime: '2026-01-01T00:00:00.000Z', fields: { Title: 'Broken link', Files: [
    { id: 'attF', url: `http://127.0.0.1:${port}/files/missing.bin`, filename: 'gone.bin', size: 1, type: 'application/octet-stream' } ] } },
  { id: 'recF0004', createdTime: '2026-01-01T00:00:00.000Z', fields: { Title: 'No files' } },
];

const SCHEMA = { tables: [
  { id: 'tblProj', name: 'Projects/2026', primaryFieldId: 'fld1', views: [], fields: [
    { id: 'fld1', name: 'Name', type: 'singleLineText' }, { id: 'fld2', name: 'Hours', type: 'number' },
    { id: 'fld3', name: 'Done', type: 'checkbox' }, { id: 'fld4', name: 'Tags', type: 'multipleSelects' },
    { id: 'fld5', name: 'Owner', type: 'singleCollaborator' }, { id: 'fld6', name: 'Memo', type: 'multilineText' },
    { id: 'fld7', name: 'Never filled', type: 'singleLineText' }, { id: 'fld8', name: '_recordId', type: 'singleLineText' } ] },
  { id: 'tblFiles', name: 'Files', primaryFieldId: 'fldT', views: [], fields: [
    { id: 'fldT', name: 'Title', type: 'singleLineText' }, { id: 'fldF', name: 'Files', type: 'multipleAttachments' } ] },
] };

function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  requests.push({ at: Date.now(), url: req.url, auth: req.headers.authorization });
  const send = (code, body, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
  if (FILES[url.pathname]) return send(200, FILES[url.pathname], { 'content-type': 'application/octet-stream' });
  if (url.pathname.startsWith('/files/')) return send(404, 'nope');
  if (req.headers.authorization !== 'Bearer ' + TOKEN) return send(401, { error: { type: 'AUTHENTICATION_REQUIRED', message: 'Authentication required' } });
  if (url.pathname === `/v0/meta/bases/${BASE}/tables`) return send(200, SCHEMA);
  const m = url.pathname.match(/^\/v0\/([^/]+)\/([^/]+)$/);
  if (!m || m[1] !== BASE) return send(404, { error: { type: 'NOT_FOUND' } });
  const all = m[2] === 'tblProj' ? projectRecords : m[2] === 'tblFiles' ? fileRecords() : null;
  if (!all) return send(404, { error: { type: 'NOT_FOUND' } });
  const start = url.searchParams.get('offset') ? Number(url.searchParams.get('offset').replace('off', '')) : 0;
  if (m[2] === 'tblProj' && start === 100 && throttled429 < 2) { throttled429++; return send(429, { error: { type: 'RATE_LIMIT_REACHED', message: 'Too many requests' } }); }
  const pageSize = Number(url.searchParams.get('pageSize') || 100);
  assert.ok(pageSize <= 100);
  const body = { records: all.slice(start, start + pageSize) };
  if (start + pageSize < all.length) body.offset = 'off' + (start + pageSize);
  return send(200, body);
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'ab-test-'));
  server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  process.env.AIRTABLE_API_URL = `http://127.0.0.1:${port}`;
});
after(() => server.close());

const lib = await import('../airtable-backup.mjs');

// ---------------------------------------------------------------- CSV helpers
function parseCsv(text) { // independent minimal RFC 4180 parser
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; continue; }
    if (c === '"') q = true; else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\r' && text[i + 1] === '\n') { row.push(f); rows.push(row); row = []; f = ''; i++; }
    else f += c;
  }
  assert.equal(f, ''); assert.equal(row.length, 0, 'file must end with CRLF');
  return rows;
}

test('csvField quotes only when needed and doubles quotes', () => {
  assert.equal(lib.csvField('plain'), 'plain');
  assert.equal(lib.csvField('a,b'), '"a,b"');
  assert.equal(lib.csvField('say "hi"'), '"say ""hi"""');
  assert.equal(lib.csvField('l1\nl2'), '"l1\nl2"');
  assert.equal(lib.csvField('l1\r\nl2'), '"l1\r\nl2"');
  assert.equal(lib.csvField(''), '');
  assert.equal(lib.csvField(3.5), '3.5');
});

test('neutralise prefixes formula triggers only', () => {
  for (const s of ['=1+1', '+1', '-1', '@x', '\tx', '\rx']) assert.equal(lib.neutralise(s), "'" + s);
  for (const s of ['plain', '1+1', 'a=b', '']) assert.equal(lib.neutralise(s), s);
});

test('safeName removes path separators and reserved characters', () => {
  assert.equal(lib.safeName('../../evil.txt'), '__.._evil.txt');
  assert.equal(lib.safeName('Projects/2026'), 'Projects_2026');
  assert.equal(lib.safeName('a:b*c?"d"<e>|f'), 'a_b_c__d__e__f');
  assert.equal(lib.safeName('...'), '_');
  assert.equal(lib.safeName(''), 'unnamed');
  assert.equal(lib.safeName('CON'), '_CON');
  assert.ok(lib.safeName('x'.repeat(300) + '.pdf').length <= 120);
  assert.ok(lib.safeName('x'.repeat(300) + '.pdf').endsWith('.pdf'));
});

test('uniqueName appends a counter before the extension, case-insensitively', () => {
  const used = new Set();
  assert.equal(lib.uniqueName(used, 'a.txt'), 'a.txt');
  assert.equal(lib.uniqueName(used, 'A.txt'), 'A_2.txt');
  assert.equal(lib.uniqueName(used, 'a.txt'), 'a_3.txt');
});

test('cellText converts every Airtable value shape', () => {
  const t = (v, o) => lib.cellText(v, o).text;
  assert.equal(t(null), ''); assert.equal(t(0), '0'); assert.equal(t(true), 'true'); assert.equal(t('x'), 'x');
  assert.equal(t(['a', 'b']), 'a, b');
  assert.equal(t({ id: 'u', email: 'a@example.com', name: 'A' }), 'A <a@example.com>');
  assert.equal(t([{ id: 'u1', email: 'a@example.com', name: 'A' }, { id: 'u2', email: 'b@example.com' }]), 'A <a@example.com>\nb@example.com');
  assert.equal(t({ label: 'Open', url: 'https://example.com' }), 'Open (https://example.com)');
  assert.equal(t({ specialValue: 'NaN' }), 'NaN');
  assert.equal(t({ error: '#ERROR!' }), '#ERROR!');
  assert.equal(t({ a: 1 }), '{"a":1}');
  const att = [{ id: 'att1', url: 'https://x/y', filename: 'a b.pdf' }];
  assert.equal(t(att), 'a b.pdf (https://x/y)');
  assert.equal(t(att, { attachmentPaths: new Map([['att1', 'attachments/T/rec1_a b.pdf']]) }), 'attachments/T/rec1_a b.pdf');
  assert.equal(lib.cellText(-5).literal, true);
});

test('tableColumns avoids clashing with schema field names', () => {
  const c = lib.tableColumns({ fields: [{ name: '_recordId' }, { name: 'X' }] });
  assert.deepEqual(c.header, ['_recordId_', '_createdTime', '_recordId', 'X']);
});

// ---------------------------------------------------------------- end to end against the mock
test('export: every table, pagination, 429 retry, RFC 4180 round trip, schema.json', async () => {
  requests.length = 0; throttled429 = 0;
  const sentAt = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, ...rest) => { if (String(url).includes('/v0/')) sentAt.push(Date.now()); return realFetch(url, ...rest); };
  const out = path.join(tmp, 'plain');
  let manifest;
  try { manifest = await lib.exportBase({ token: TOKEN, base: BASE, out }); } finally { globalThis.fetch = realFetch; }
  assert.deepEqual(manifest.tables.map((t) => [t.name, t.records, t.file]), [['Projects/2026', 250, 'Projects_2026.csv'], ['Files', 4, 'Files.csv']]);
  assert.equal(throttled429, 2, 'the mock rate-limited twice and the client recovered');

  const schema = JSON.parse(fs.readFileSync(path.join(out, 'schema.json'), 'utf8'));
  assert.deepEqual(schema, SCHEMA);

  const rows = parseCsv(fs.readFileSync(path.join(out, 'Projects_2026.csv'), 'utf8'));
  assert.equal(rows.length, 251);
  assert.deepEqual(rows[0], ['_recordId_', '_createdTime', 'Name', 'Hours', 'Done', 'Tags', 'Owner', 'Memo', 'Never filled', '_recordId']);
  assert.ok(rows.every((r) => r.length === rows[0].length));
  assert.deepEqual(rows.slice(1).map((r) => r[0]), projectRecords.map((r) => r.id));
  assert.equal(rows[1][2], 'Quote " and, comma');
  assert.equal(rows[2][2], 'Line one\nLine two');
  assert.equal(rows[3][2], '=HYPERLINK("http://example.com")', 'no --safe: left as is');
  assert.equal(rows[4][2], 'Zoë – 日本語');
  assert.equal(rows[5][3], '-2.5');
  assert.equal(rows[1][4], 'true'); assert.equal(rows[2][4], '');
  assert.equal(rows[6][5], 'a, b, c');
  assert.equal(rows[7][6], 'Sam <sam@example.com>');
  assert.equal(rows[1][8], '', 'schema field with no values still gets a column');

  const raw = fs.readFileSync(path.join(out, 'Projects_2026.csv'), 'utf8');
  assert.ok(raw.endsWith('\r\n'));
  assert.equal(raw.split('\r\n').length, 252, 'header + 250 records + trailing empty');
  assert.ok(!raw.startsWith('\uFEFF'));
  assert.ok(!fs.existsSync(path.join(out, 'attachments')), 'no attachment directory without --attachments');

  const api = requests.filter((r) => r.url.startsWith('/v0/'));
  assert.ok(api.every((r) => r.auth === 'Bearer ' + TOKEN));
  // Spacing is measured where the client sends the request (server-side arrival times jitter with the event loop).
  const gaps = sentAt.slice(1).map((t, i) => t - sentAt[i]);
  assert.equal(sentAt.length, api.length);
  assert.ok(gaps.length >= 6 && Math.min(...gaps) >= 215, 'API requests at least ~220 ms apart (<= 5 per second), got gaps ' + gaps.join(','));
});

test('--safe neutralises formulas in text but not numbers; --bom adds a BOM', async () => {
  const out = path.join(tmp, 'safe');
  await lib.exportBase({ token: TOKEN, base: BASE, out, safe: true, bom: true, only: ['tblProj'] });
  const raw = fs.readFileSync(path.join(out, 'Projects_2026.csv'), 'utf8');
  assert.ok(raw.startsWith('\uFEFF'));
  const rows = parseCsv(raw);
  assert.equal(rows[3][2], "'=HYPERLINK(\"http://example.com\")");
  assert.equal(rows[8][7], "'@SUM(1)");
  assert.equal(rows[9][7], "'+1 555 0100");
  assert.equal(rows[5][3], '-2.5', 'negative numbers are numbers, not text');
  assert.equal(rows[1][2], 'Quote " and, comma');
});

test('--attachments downloads files right after each page, safe names, no clobbering', async () => {
  const out = path.join(tmp, 'att');
  const manifest = await lib.exportBase({ token: TOKEN, base: BASE, out, attachments: true, only: ['Files'] });
  const dir = path.join(out, 'attachments', 'Files');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['recF0001_logo.png', 'recF0001_report.pdf', 'recF0002_.._.._evil.txt', 'recF0002_notes.txt', 'recF0002_notes_2.txt']);
  assert.ok(fs.readFileSync(path.join(dir, 'recF0001_report.pdf')).equals(FILES['/files/a.pdf']));
  assert.ok(fs.readFileSync(path.join(dir, 'recF0001_logo.png')).equals(FILES['/files/b.png']));
  assert.equal(fs.readFileSync(path.join(dir, 'recF0002_notes.txt'), 'utf8'), 'same name 1');
  assert.equal(fs.readFileSync(path.join(dir, 'recF0002_notes_2.txt'), 'utf8'), 'same name 2');
  // nothing escaped the output directory
  assert.ok(!fs.existsSync(path.join(out, '..', 'evil.txt')) && !fs.existsSync(path.join(out, 'evil.txt')));
  assert.equal(fs.readdirSync(dir).length, 5);
  assert.equal(manifest.tables[0].attachmentFiles, 5);
  assert.equal(manifest.attachmentFailures.length, 1);
  assert.equal(manifest.attachmentFailures[0].file, 'gone.bin');

  const rows = parseCsv(fs.readFileSync(path.join(out, 'Files.csv'), 'utf8'));
  assert.equal(rows[1][3], 'attachments/Files/recF0001_report.pdf\nattachments/Files/recF0001_logo.png');
  assert.equal(rows[2][3].split('\n')[1], 'attachments/Files/recF0002_notes_2.txt');
  assert.match(rows[3][3], /^gone\.bin \(http:\/\/127\.0\.0\.1:\d+\/files\/missing\.bin\)$/, 'failed download keeps the URL in the CSV');
  assert.equal(rows[4][3], '');
});

test('exportBase rejects bad token and unknown table filter with readable errors', async () => {
  await assert.rejects(lib.exportBase({ token: 'wrong', base: BASE, out: path.join(tmp, 'bad1') }), /schema: HTTP 401.*Check AIRTABLE_TOKEN/);
  await assert.rejects(lib.exportBase({ token: TOKEN, base: 'appNOPE0000000000', out: path.join(tmp, 'bad2') }), /HTTP 404/);
  await assert.rejects(lib.exportBase({ token: TOKEN, base: BASE, out: path.join(tmp, 'bad3'), only: ['Nope'] }), /No table matches Nope.*Projects\/2026, Files/);
});

// ---------------------------------------------------------------- CLI
// Async spawn: the mock server runs in this process, so a blocking spawnSync would deadlock.
const cli = (args, env = {}) => new Promise((resolve) => {
  const child = spawn('node', [CLI, ...args], { env: { ...process.env, ...env } });
  let stdout = '', stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  child.on('close', (status) => resolve({ status, stdout, stderr }));
});

test('CLI: help, missing token, bad base', async () => {
  const h = await cli(['--help']);
  assert.equal(h.status, 0); assert.match(h.stdout, /--attachments/);
  const noTok = await cli(['--base', BASE], { AIRTABLE_TOKEN: '' });
  assert.equal(noTok.status, 2); assert.match(noTok.stderr, /AIRTABLE_TOKEN/);
  const badBase = await cli(['--base', 'tblXYZ'], { AIRTABLE_TOKEN: TOKEN });
  assert.equal(badBase.status, 2);
  assert.equal((await cli(['--nonsense'], { AIRTABLE_TOKEN: TOKEN })).status, 2);
});

test('CLI: full run exits 0; exits 3 when an attachment could not be downloaded', async () => {
  const ok = await cli(['--base', BASE, '--out', path.join(tmp, 'cli1'), '--table', 'Projects/2026'], { AIRTABLE_TOKEN: TOKEN });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stderr, /Projects\/2026: 250 records/);
  assert.ok(fs.existsSync(path.join(tmp, 'cli1', 'schema.json')));
  const partial = await cli(['--base', BASE, '--out', path.join(tmp, 'cli2'), '--attachments'], { AIRTABLE_TOKEN: TOKEN });
  assert.equal(partial.status, 3, partial.stderr);
  assert.match(partial.stderr, /1 attachment download\(s\) failed/);
  const unauth = await cli(['--base', BASE, '--out', path.join(tmp, 'cli3')], { AIRTABLE_TOKEN: 'wrong' });
  assert.equal(unauth.status, 1); assert.match(unauth.stderr, /HTTP 401/);
});
