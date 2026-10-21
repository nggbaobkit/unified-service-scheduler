# Project guide

## Purpose and boundaries

This is a local vehicle-service appointment scheduler: React/TypeScript, an Express API, and file-backed SQLite. Read `README.md` for commands and `ARCHITECTURE.md` for the current design.

Keep changes focused. Do not add infrastructure or product features without a requirement. The intentional boundaries are:

- Demo profiles, not authentication. Profile selection is tab-scoped and anybody can choose any fictional customer.
- One global service catalog for all dealerships. Technician qualifications remain individual database relationships.
- One shared working calendar in `src/server/config/workingHours.ts`, interpreted in each dealership's timezone.
- Availability is advisory. Selecting a time does not create a hold.
- Local, single-instance operation. Do not present this as a production authentication or multi-instance deployment.

## Code ownership by layer

- `src/server/scheduler.ts`: authoritative context validation, working-period/overlap checks, availability, and transactional booking.
- `src/server/persistence/database.ts`: schema/migrations, integrity constraints, and database readers.
- `src/server/config/workingHours.ts`: the only definition of fixed working days and hours.
- `src/server/persistence/seed.ts`: non-destructive catalog seeding and isolated demo preparation.
- `src/server/cli/prepareDemo.ts` and `src/server/cli/seedCatalog.ts`: operator command entry points, not HTTP handlers.
- `src/server/app.ts`: HTTP input validation, selected-profile handling, routes, and structured errors.
- `src/shared/contracts.ts`: runtime Zod schemas and corresponding TypeScript types.
- `src/client`: profile chooser, API client, time picker, booking confirmation, and appointment ledger. The client displays server availability; it must not independently reimplement scheduling rules.

Keep the server layout shallow: bootstrap, HTTP composition, and booking logic stay at its root; configuration, persistence, and CLI tools have their own folders. Do not add controller/repository/interface layers solely to create more structure.

## Naming conventions

Name things for their behavior, not only their return type.

| Kind | Convention | Examples |
|---|---|---|
| Ordinary functions and methods | Action-oriented `camelCase` | `resolveBookingContext`, `findAvailableResources`, `confirmAppointment` |
| Readers | `get`, `list`, `find`, or `resolve`, followed by the subject | `getCatalog`, `listAppointments`, `getAvailabilityWindow` |
| Boolean helpers | Predicate names starting with `is`, `has`, or `can` | `isWithinWorkingPeriod` |
| Format/conversion helpers | Describe the transformation | `formatDate`, `formatUtcOffset`, `resolveLocalTime` |
| Event handlers | An action name, or `handle` plus the event | `chooseProfile`, `updateBookingIntent`, `handleProfileUnavailable` |
| Test factories and assertions | Make creation, execution, or assertion explicit | `createTestFixture`, `createBookingIntent`, `runBookingRace`, `expectUnavailableTime` |
| Types, classes, React components | Descriptive `PascalCase` nouns | `Appointment`, `Scheduler`, `TimePicker` |
| Values and properties | Descriptive `camelCase` nouns or states | `bookingContext`, `availableResources`, `loading`, `replayed` |
| Shared fixed configuration | `UPPER_SNAKE_CASE` | `SERVICE_SCHEDULE` |

- Read-oriented helpers must not mutate persistent business data. They may read the database, validate, and throw an explicit domain error.
- `findAvailableResources` finds a candidate technician/bay and service window; it does not reserve them. `confirmAppointment` creates the record or returns an idempotent replay.
- Avoid noun-only ordinary function names such as `selection()` or `catalog()`. React components and callback roles such as `logger`, `now`, and `afterInsert` are different: preserve their established role-based naming.
- Not every `const` is an uppercase constant. Local values and SQL/schema descriptions remain `camelCase`.
- React component files use `PascalCase.tsx`; ordinary module files use descriptive lower/camel-case names. Tests use `.test.ts` for Vitest and `.spec.ts` for Playwright.
- ESLint checks casing. Semantic choices such as read versus write intent must also be checked during review.
- Use symbol-aware renaming when possible. Update declarations, imports, callers, tests, and documentation together. Do not rename HTTP routes, JSON keys, SQL columns, or error codes merely to match an internal function rename.

## Booking guarantees to preserve

- `confirmAppointment` starts an immediate SQLite write transaction before authoritative reads. The idempotency lookup, resource checks, and insert belong to that transaction.
- It calls `findAvailableResources`, which first calls `resolveBookingContext`. Follow that real call path when documenting or explaining the code.
- Reuse the same rules for `previewAvailability`, `getAvailabilityWindow`, and confirmation. Do not create a weaker preview-only interpretation.
- Require a qualified technician and a bay at the selected dealership for the entire service. Respect the shared working periods and breaks.
- Prevent overlapping appointments for the technician, bay, and vehicle. Intervals are half-open: exact adjacency is valid.
- Service duration is server-owned. Store UTC appointment instants; interpret wall-clock input in the dealership's IANA timezone with Temporal. Reject ambiguous/nonexistent local times explicitly.
- Persist the idempotency key and normalized request identity with the appointment. Identical retries return the original record, even after its start time. Different intents or profiles cannot reuse that key as a successful replay.
- Keep foreign keys and relationship constraints enabled. Database constraints protect associations; transaction-bound overlap checks protect availability.
- Keep the original saved request after uncertain network results. Do not replace it with a new key or claim that no appointment exists without evidence.

## Types and errors

- Keep strict TypeScript types. Parse untrusted HTTP and database values using the existing schemas; avoid `any` and double casts.
- Use `DomainError` and the established `{ error: { code, message, requestId } }` response shape for expected failures.
- Distinguish validation errors, resource conflicts, database contention, and unknown failures. Do not turn failures into empty successful results.
- Log request/operation/error identifiers without customer payloads, secrets, or local credentials.
- Comment non-obvious rules or transaction behavior, not statements that are already self-explanatory.

## Data and process safety

- `.data` can contain somebody's working demo. Do not delete, overwrite, reseed, or reset it as part of routine development or verification.
- `demo:prepare` creates a new database and refuses existing destinations. `seed` preserves existing records. Tests create isolated databases and clean up only their own files.
- Back up a database before a migration. Use SQLite's backup mechanism, or stop all writers before copying; copying only the main file during WAL activity is unsafe.
- Migration tests must preserve retained records, appointment IDs, retry keys, foreign-key integrity, and indexes. Test the real legacy schema relationships, not only a changed version number.
- Before starting a server, check whether the requested port is already in use. Reuse a healthy instance or stop only a verified process belonging to this work. Never terminate processes by executable name.
- Do not commit databases, generated builds, test output, secrets, machine-specific paths, or private authoring metadata.

## Development and verification

Use Node.js 24+ and npm. Install/restore dependencies when manifests changed or dependencies are missing, not as a routine prelude to every task.

The main commands are:

```powershell
npm run typecheck
npm run lint
npm test
npm run build
npm run test:e2e
```

- Start with the smallest relevant test selection. Broader refactors require the affected suites, not only compilation.
- Browser tests use the built app: rebuild before `test:e2e`. The current local setup uses Microsoft Edge through Playwright.
- After moving server files, remove only their obsolete generated files under `dist/server` before rebuilding; stale output must not hide a broken import or old entry point.
- Keep concurrency tests on independent connections/processes. Sequential clicks in two tabs demonstrate stale-preview handling, not simultaneous writes.
- Failure-injection tests must observe the expected structured error and operation-specific marker before claiming rollback. A network failure or unchanged row count alone is not proof.
- For UI changes, exercise keyboard/focus behavior, mobile and short viewports, zoom, both themes, long content, and the relevant recovery flow. Check a dialog's own bounds and scroll container.
- `npm run dev` runs the client on 5173 and API on 3001. `npm start -- --database .data\demo.sqlite` serves the built app on 3001. Bind locally and preserve the intended database path.

## UI and documentation

- Reuse the existing CSS variables and components. Preserve the current visual direction, accessible labels, visible focus, non-color status cues, and reduced-motion support.
- Explain confirmation conflicts visibly, but distinguish them from uncertain outcomes. Keep profile-specific retry state isolated when switching profiles.
- Label appointment values explicitly in confirmations and lists, including technician, service bay, vehicle ID, and appointment ID. Do not rely on unlabeled names or dot-separated identifiers.
- Keep `README.md` and `ARCHITECTURE.md` consistent with code and behavior.
- Keep ADR numbering and cross-references consistent when reorganizing decisions.
- Do not claim a test passed or a live operation occurred unless it was actually observed.
