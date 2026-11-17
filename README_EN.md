# Nursing Defect Remediation Desk

> A desktop tray app for hospital nursing quality-control teams. It takes over **after** an incident is reported: grading, remediation, review, closure and write-back, with a durable step timeline and a receipt you can reconcile.

## 1. What & Who

Nursing incident reporting systems stop at "reported". The work after that — grading the defect, agreeing remediation, reviewing it, closing the case and writing the conclusion back to the QC system — usually lives in chat threads and spreadsheets. This tool is for nursing quality-control staff, ward nurse managers, team leaders and the nursing director. It polls new reports, turns each into a persisted run with named steps, suspends while waiting for a human reply (across days, sleep and restarts), and produces a reconciled ledger. Model output is always a **draft**: grading, remediation, review and closure require human confirmation before any write request is sent.

## 2. Core Capabilities

- **Durable step execution**: one incident = one SQLite run; named steps, step-hash idempotency, a single `resume` entry point, keyed concurrency gate, drain-on-quit.
- **Persistent waiting**: pauses are stored independently; elapsed time accumulates across restarts and sleep, and the timeline separates "waiting for a person" from "running in the system".
- **Exactly-once write-back**: `sha256(incident_id|review|revision)` idempotency key, optimistic `revision` (409 goes to a human), receipt persisted and shown in both window and ledger.
- **Guard rails**: enum/required/time-order validation, citation re-check (`hallucinated_citation` is dropped from the payload), clause hints with file/section/clause references, no compliance verdicts.
- **Model gateway**: one OpenAI-compatible client with structured `json_schema` responses, retry/backoff, degradation to a rule-based coarse draft that never advances state, and per-call token/cost audit.
- **Privacy by default**: patient names, admission numbers, bed numbers, ID and phone numbers are redacted in the window, exports and reminders; missing encounter IDs are never guessed.
- **Desktop workbench**: three-column layout, incremental polling that keeps previous data, loading/empty/error states, keyboard access, xlsx ledger and overdue csv exports.

## 3. Quick Start

```bash
npm ci
cp .env.example .env          # fill 7 required endpoint/credential variables
npm run dev                   # desktop tray app (needs npm run build first)
npm run doctor                # configuration check + OpenAPI contract parse
npm test                      # full suite
npm run verify                # contracts -> fixtures -> slice -> 1000-run replay -> export -> doctor
npm run export                # xlsx ledger + overdue csv from app-data/runtime.db
```

GUI is the daily entry point; CLI is for setup and troubleshooting. Full documentation: see README.md (Chinese).

## 4. Repository Layout

```
nursing-defect-remediation/
├── src/          # config, domain, store, runtime, gateway, rules, adapters, export, main, ui
├── tests/        # unit, protocol stubs (tests/ only), regression suites
├── scripts/      # replay, baseline, stress, contract check, verify, screenshot capture
├── docs/         # OpenAPI 3.1 contracts, corpus, examples, concepts, screenshots
├── fixtures/     # de-identified sample reports
├── config/       # synonym configuration for synthetic reports
├── README.md     # full Chinese documentation
├── package.json
└── tsconfig.json
```

## Follow Us

Scan the QR code in `qrcode.jpg` for project updates.

![Follow Us](qrcode.jpg)

---

## Follow Us

Scan the QR code to follow our official account for updates and community access:

![Follow Us](qrcode.jpg)