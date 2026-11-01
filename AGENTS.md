# Djupleita development

This repository contains the macOS pentest distribution at its root. `vendor/deepseek-harness` is an ignored, commit-pinned dependency. Persist upstream changes as reviewable patches under `patches/`; never rely on an uncommitted vendor edit. Bootstrap verifies the pinned commit before applying patches.

Never commit `.pentest/`, provider credentials, engagement data, private keys or runtime screenshots. Publish only visually reviewed screenshots under `docs/images/`. Install the scanner and hooks described in `SECURITY.md`, and run the relevant focused tests before committing. Do not bypass a failed secret check or add broad scan exclusions.

Treat confidential customer and assessment references as secrets, including in test domains and screenshot pixels. Use reserved `example.test` fixtures. The secret guard includes custom reference rules and local OCR; install Tesseract with English data before publishing image changes. Keep the protected-name list and derived patterns out of source control. Tests use unrelated synthetic names and generate canary images only at runtime.

For distribution changes use `pnpm typecheck`, `pnpm build`, and the affected Vitest files. Tests that open loopback sockets may need host execution when the development sandbox denies listening. Do not run real model calls or target scans as a release check. Keep the existing user's app and credentials untouched.

Pedram Amini's receiver lives in `course/audit-stream/worker`. Preserve seat/course authorization, digest verification, immutable record custody, live board, seat listing and operator publishing when changing it. Test the app-to-receiver path with `tests/course-audit.test.ts`, and run the worker's `npm test` and `npm run typecheck` for worker changes. Cloudflare deployment requires an explicit deployment request.
