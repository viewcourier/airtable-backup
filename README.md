# airtable-backup

A zero-dependency Node.js command line tool that exports every table of an Airtable base to CSV, saves the base schema as JSON, and can download the attachment files too. One file, `airtable-backup.mjs`, Node 18 or newer, nothing to install.

```
export AIRTABLE_TOKEN=your_personal_access_token
node airtable-backup.mjs --base appXXXXXXXXXXXXXX
```

- Exports **all tables** of the base, **all fields** (including fields that are empty in every record), one CSV per table.
- CSV follows RFC 4180: comma separated, CRLF line ends, fields with commas, quotes or line breaks are quoted, quotes are doubled, UTF-8.
- Optional `--safe` flag neutralises spreadsheet formula injection.
- Writes `schema.json`, the full response of Airtable's metadata API (tables, fields with types and options, views).
- Optional `--attachments` downloads attachment files.
- Stays under Airtable's 5 requests per second limit and retries HTTP 429 and 5xx responses.

## Usage

```
node airtable-backup.mjs --base appXXXXXXXXXXXXXX [--out dir] [--attachments] [--safe] [--table name] [--bom]
```

| Option | Meaning |
| --- | --- |
| `--base <id>` | Base ID, starts with `app`. Required. |
| `--out <dir>` | Output directory. Default `./airtable-backup-<base id>`. Created if missing. |
| `--attachments` | Download attachment files to `<out>/attachments/<table>/<recordId>_<filename>`. |
| `--safe` | Prefix text cells that start with `=`, `+`, `-`, `@`, tab or carriage return with an apostrophe, so Excel, Google Sheets and LibreOffice show them as text instead of running them as formulas. Numbers are not touched. |
| `--table <name or id>` | Export only this table. Repeat for several. Default: all tables. |
| `--bom` | Start each CSV with a UTF-8 byte order mark. Excel on Windows needs it to read accented characters correctly. |

The token is read from the `AIRTABLE_TOKEN` environment variable only. It is never written to disk or printed.

Exit codes: `0` success, `1` error (bad token, no access, network), `2` bad arguments, `3` finished but some attachment downloads failed (listed in `manifest.json`).

## Token scopes

Create a personal access token at [airtable.com/create/tokens](https://airtable.com/create/tokens) with these scopes and access to the base (or to all bases in the workspace):

- `data.records:read`: read the records.
- `schema.bases:read`: read the table and field definitions (needed for `schema.json` and for the full column list).

## Example output

```
airtable-backup-appXXXXXXXXXXXXXX/
  schema.json                      full metadata API response
  manifest.json                    tables, file names, record counts, attachment failures
  Clients.csv
  Work log.csv
  Invoices.csv
  attachments/                     only with --attachments
    Invoices/
      recAbC123dEf456_invoice-2026-10.pdf
      recAbC123dEf456_receipt.png
      recGhI789jKl012_contract.pdf
```

Each CSV has two leading columns followed by every field in the order of the Airtable schema:

```
_recordId,_createdTime,Task,Date,Hours,Status,Notes,Client
recAAAAAAAAAAAAAA,2026-10-27T23:02:57.000Z,Document template cleanup,2026-10-19,3.5,Done,,recBBBBBBBBBBBBBB
```

`_recordId` is the Airtable record ID, `_createdTime` the record creation time. (If a field already has one of those names, an underscore is appended to the column name.) The console prints one line per table:

```
Base appXXXXXXXXXXXXXX: 3 table(s)
  Clients: 5 records -> Clients.csv
  Work log: 16 records -> Work log.csv
  Invoices: 40 records -> Invoices.csv, 52 attachment file(s)
Done: 3 table(s), 61 records -> /path/to/airtable-backup-appXXXXXXXXXXXXXX
```

### How cell values are written

| Airtable value | CSV cell |
| --- | --- |
| Text, number, date | As returned by the API (dates as `2026-10-19` or ISO timestamps) |
| Checkbox | `true`; unchecked is empty (the API omits it) |
| Multiple select, linked records, lookups | Items joined with `, ` (linked records appear as record IDs) |
| Collaborator | `Name <email>` |
| Button | `label (url)` |
| Attachment | Without `--attachments`: `filename (url)`, one per line. With it: the relative path of the downloaded file, one per line. A file that failed to download keeps `filename (url)`. |
| Formula error | The error text |
| Other objects | JSON |

## Limits

- **Attachment URLs expire after about two hours.** The tool downloads each page's attachments right after fetching that page, but a CSV made without `--attachments` holds links that stop working. If you need the files, use `--attachments`.
- **Rate limit.** Airtable allows 5 requests per second per base. The tool spaces requests about 220 ms apart and, on HTTP 429, waits 30 seconds (or the `Retry-After` value) and tries again, up to 6 times. Large bases are therefore slow: 100 records per request means about 25 seconds for 10,000 records.
- **What a CSV backup does not contain:** views, filters, automations, interface designs, comments, and formula definitions (only results). `schema.json` records tables, fields, field types and options, and views by name. For a full restorable copy use Airtable's own base snapshots in addition.
- **Rich text, long text and linked records** are exported as the API returns them (markdown text, record IDs).
- Restoring: Airtable's CSV import creates new tables with new record IDs and loses linked record relationships. Keep `schema.json` and the `_recordId` column to rebuild links.

## Tests

```
npm test                  # or: node --test test/backup.test.mjs
```

Runs unit tests and an end-to-end run against a local mock of the Airtable API (pagination, 429 retry, request spacing, attachment download, name clashes, `--safe`, exit codes). The demo bases of the real API have no attachments, so the mock covers that part.

To check against the real API, with a token that can read the bases:

```
AIRTABLE_TOKEN=... node test/e2e.mjs /some/empty/dir
AIRTABLE_TOKEN=... node test/verify.mjs --base appXXXXXXXXXXXXXX --out /some/empty/dir/appXXXXXXXXXXXXXX --attachments
```

`e2e.mjs` backs up every base the token can list and runs `verify.mjs` on each. `verify.mjs` counts the records through the API with its own paging, parses the CSVs with its own RFC 4180 parser, and checks that the row counts and record IDs match, that `schema.json` lists every table and field, and that every attachment has a file on disk.

## FAQ

**Can I run it on a schedule?** Yes: put the command in cron or a CI job and write to a dated directory, for example `--out backups/$(date +%F)`. Keep the token in the scheduler's secret store.

**Does it back up all my bases?** One base per run. List bases with `GET https://api.airtable.com/v0/meta/bases` and run the tool for each ID (`test/e2e.mjs` does exactly this).

**Does it work with Excel?** Yes. Use `--bom` so accented characters display correctly, and `--safe` if the data comes from people you do not control.

**Why are the column names `_recordId` and `_createdTime` first?** A backup is only useful for restoring if you can tell which row is which record. They can be deleted from the CSV before importing elsewhere.

## Other ways to export Airtable data

- Browser tool, no install: [Airtable base to CSV](https://viewcourier.com/tools/airtable-base-to-csv?utm_source=github&utm_medium=readme&utm_campaign=airtable-backup) downloads every table of a base as CSV in one ZIP.
- Guide: [Airtable backup: automatic full-base backups](https://viewcourier.com/guides/airtable-automatic-backup-csv?utm_source=github&utm_medium=readme&utm_campaign=airtable-backup) covers what Airtable snapshots include, what a CSV backup does and does not protect, and how to restore. All guides: [viewcourier.com/guides](https://viewcourier.com/guides/).
- Want it emailed as CSV, Excel or PDF on a schedule instead? [ViewCourier](https://viewcourier.com/?utm_source=github&utm_medium=readme&utm_campaign=airtable-backup) sends an Airtable view to any list of recipients on a schedule, with no script to run or host.

## License

MIT. Copyright (c) 2026 BASIT B.V.
