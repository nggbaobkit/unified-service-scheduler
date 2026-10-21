# Unified Service Scheduler

A local appointment scheduler that reserves a qualified technician and service bay for the entire service, while preventing overlapping appointments for the vehicle.

The UI is called **Service Studio**. It uses real API-backed SQLite persistence, including the sample workspace.

## Requirements

- Node.js 24 or later and npm.
- Microsoft Edge for the browser tests on this Windows setup.
- No database server, cloud account, credentials, or external API is required.

## Run the demo

Run these commands from the repository root in PowerShell:

```powershell
npm ci
npm run demo:prepare -- --database .data\demo.sqlite
npm run build
npm start -- --database .data\demo.sqlite
```

Open **http://127.0.0.1:3001**.

Choose **Alex**, **Jamie**, **Riley**, or **Taylor** on the entry screen. The main workspace shows that profile's vehicles and appointments. **Switch profile** returns to the chooser without putting a customer selector inside the booking form.

The choice lives in this tab's session storage. Open the same URL in two tabs and select Jamie in one and Taylor in the other for the competing-bookings demo. Switching one tab does not switch the other. No passwords, account setup, special URLs, or separate browser profiles are needed.

This is **demo selection, not authentication**. Anyone can choose any sample profile.

Preparation prints the database path and future weekday dates `demoDate` (D) and `nextDemoDate` (E), and creates two initial sample appointments. Choose those dates in the date strip for the walkthrough. All sample people and vehicles are fictional.

The preparation command **refuses an existing database path**. For another rehearsal or recording, choose a new path such as `.data\recording.sqlite`, then pass that same path when starting the app. It never resets an existing workspace.

To choose a particular future weekday:

```powershell
npm run demo:prepare -- --database .data\dated-demo.sqlite --date YYYY-MM-DD
```

Replace `YYYY-MM-DD` with a future Monday-Friday date in `Asia/Ho_Chi_Minh`. Past dates, weekends, and invalid dates are rejected.

To demonstrate persistence, stop the server with Ctrl+C and run the **same start command** again, then reload the page. The tab's selection and the database's appointments remain. Do not prepare or seed another database between runs.

## Pick an appointment time

Choose a dealership, service, and vehicle. Availability loads automatically:

1. The date strip shows seven days starting today in the dealership timezone. **Previous** and **Next** move a week at a time; you cannot navigate before today.
2. Select a day, then choose an available start-time button. Starts are spaced 15 minutes apart, but the booking reserves the full service duration.
3. Review the complete time window and confirm. Changing any booking choice clears the selected time.

The confirmation and appointment list label each field explicitly, including technician, service bay, vehicle ID, and appointment ID.

Closed days and days without availability are labeled explicitly. Expand **Unavailable times** to inspect reasons such as a busy bay, unavailable qualified technician, shift break, or closing time. Those times are not selectable. On mobile, the date strip scrolls horizontally without widening the page.

**Refresh times** reloads availability. A competing booking can still win after a time was displayed. If confirmation fails because availability changed, an in-app popup explains the reason, shows the affected service/date/dealership, and states that no appointment was created. **Choose another time** returns focus to the time picker while available times refresh. Selection remains non-blocking; no temporary holds are created. An uncertain network result instead keeps the original request for a safe retry and does not claim that nothing was booked.

## Development

For a sample catalog without prebooked appointments:

```powershell
npm run seed -- --database .data\development.sqlite
$env:DATABASE_PATH = '.data\development.sqlite'
npm run dev
```

Open **http://127.0.0.1:5173**. Vite forwards `/api` requests to the Node API at port 3001. Both servers bind to loopback and stop together with Ctrl+C. To develop with the demo bookings instead, set `DATABASE_PATH` to the prepared demo database.

Normal `seed` inserts missing catalog rows without deleting appointments or replacing existing values. It is deliberately different from fresh demo preparation.

`DATABASE_PATH` is optional; without it or `--database`, the API uses `.data\scheduler.sqlite`. For the built application, an explicit `--port` overrides `PORT`; the default is 3001. The development proxy expects API port 3001.

## Verification

```powershell
npm run typecheck
npm run lint
npm test
npm run build
npm run test:e2e
```

Browser tests run against the **built application**, so rebuild after source changes. They create isolated databases and start/stop their own API processes. They do not need a manually running server or change your demo database.

| Evidence | Location |
|---|---|
| Booking rules, ownership, boundaries, timezones, seed safety | `tests/scheduler.test.ts` |
| Exact seven-day windows, quarter-hour starts, full-duration rules, timezone/DST behavior, and paging | `tests/slots.test.ts` |
| Real competing writers on independent connections/processes | `tests/race-worker.ts` and the concurrency cases in `tests/scheduler.test.ts` |
| Structured errors, lock contention, write-failure rollback, idempotent replay | `tests/api.test.ts` |
| Profile validation, filtered reads, conflicting body identity, replay binding, and migration preservation | `tests/api.test.ts` |
| Extended UI rehearsal, two-context stale preview, actual process restart | `tests/browser/booking.spec.ts` |
| Lost response after a real commit, reload, and safe retry | `tests/browser/booking.spec.ts` |
| Independent selections in tabs of the same browser, switching, and profile-specific pending requests | `tests/browser/booking.spec.ts` |
| Responsive light/dark layouts, zoom, long labels, and keyboard interaction | `tests/browser/booking.spec.ts` |

Playwright saves screenshots under ignored `test-results` directories. Failure traces are retained for inspection. Browser tests currently select the installed `msedge` channel in `playwright.config.ts`; configure an installed Playwright browser there if using another environment.

## Booking contract

- Availability is advisory, not a reservation.
- Confirmation starts a SQLite `BEGIN IMMEDIATE` transaction **before** authoritative reads.
- The service duration is server-owned. The entire interval must fit within dealership hours and a qualified technician's shift.
- Fixed working hours come from `SERVICE_SCHEDULE` in `src/server/config/workingHours.ts`: Monday-Friday, dealerships open 09:00-17:00, technicians work 09:00-12:00 and 13:00-17:00. All dealerships and technicians share this calendar; their existing appointments still determine individual availability.
- Bay, technician, and vehicle conflicts use half-open intervals: adjacent appointments are valid; overlapping ones are not.
- The API validates the selected `X-Demo-Customer` header and uses it to scope the request. It is client-selected demo context, not proof of identity. Vehicle ownership, dealership/service existence, and assigned-resource relationships are validated, with foreign keys enforcing stored associations.
- All dealerships use the global service catalog. The `qualifications` table still determines which technicians can perform each service; a global service is unavailable at a dealership without a qualified, free technician there.
- Appointment start/end are UTC epoch milliseconds. Weekly schedules and requested local times use the dealership's IANA timezone. Ambiguous/nonexistent local times are rejected.
- The confirmation request carries a UUID idempotency key. An identical retry returns the original appointment; changing the intent with the same key is rejected.
- The browser saves an in-flight request under a profile-specific session-storage key before submitting. An uncertain result locks booking edits until that request is reconciled. Switching profiles preserves the saved request; returning to the original profile restores it, including after reload or server restart.
- SQLite lock contention returns a retryable `503 DATABASE_BUSY`, not a misleading availability conflict.

## API

All endpoints are under `/api`; mutating requests require JSON. Success bodies are validated against shared schemas.

| Method | Route | Result |
|---|---|---|
| GET | `/health` | Readiness response. |
| GET | `/profiles` | The sample customers available in the chooser. |
| GET | `/catalog` | Selected demo customer, their vehicles, global services, resources, qualifications, and demo dates. |
| POST | `/availability` | Advisory availability with a stable reason code and, when available, the service window. |
| POST | `/availability/slots` | Seven days of start times with availability/reasons and previous/next window dates. |
| POST | `/appointments` | `201` for a new appointment; `200` for an identical idempotent replay. |
| GET | `/appointments` | The selected profile's appointments, including assigned technician and bay details. |

Catalog, availability, and appointment routes require a valid `X-Demo-Customer` header, for example `alex`. Availability input: `vehicleId`, `dealershipId`, `serviceId`, and `localStart` in `YYYY-MM-DDTHH:mm` format. Confirmation adds `idempotencyKey`. Unknown fields, including a conflicting `customerId`, are rejected.

The slot-window route takes `vehicleId`, `dealershipId`, `serviceId`, and optional `startDate` (`YYYY-MM-DD`). It always returns exactly seven days, with at most 96 quarter-hour starts per day. The default first date is today at the dealership. The UI uses this route; the original single-time preview and confirmation API retain minute-precision input for compatibility.

Errors have `{ "error": { "code", "message", "requestId" } }`. Missing/unknown profiles and malformed JSON use 400, validation failures 422, booking conflicts 409, and transient database lock contention 503. The API logs request IDs and operation/error codes without logging customer payloads.

## Structure and operating limits

- `src/client`: React booking workflow, confirmation, appointment ledger, and styles.
- `src/client/TimePicker.tsx`: seven-day date navigation, time selection, and unavailable-time explanations.
- `src/client/BookingConflictDialog.tsx`: visible confirmation-failure explanation and accessible recovery.
- `src/shared`: runtime API schemas and TypeScript types.
- `src/server/scheduler.ts`: time rules and authoritative transactional allocation.
- `src/server/config/workingHours.ts`: the single shared configuration for working weekdays, opening hours, and technician working periods.
- `src/server/persistence/database.ts`: schema versioning, integrity constraints, and readers.
- `src/server/persistence/seed.ts`: catalog and isolated demo preparation.
- `src/server/cli/prepareDemo.ts` and `src/server/cli/seedCatalog.ts`: entry points for `demo:prepare` and `seed`.
- `src/server/app.ts`: HTTP boundary and structured error handling.

```text
src\server\
  index.ts
  app.ts
  scheduler.ts
  config\
    workingHours.ts
  persistence\
    database.ts
    seed.ts
  cli\
    prepareDemo.ts
    seedCatalog.ts
```

The application is **local-only and unauthenticated**. Profiles exist to make the booking demonstration natural and repeatable. Their filtering is not an access-control boundary: anyone using the app can choose a different profile. Do not expose it publicly or use real customer data. A public deployment needs actual authentication, authorization, HTTPS, and an operational security review.

Schema version 5 removes the former `dealershipServices` table and replaces its appointment foreign key with direct references to dealerships and services. It preserves appointment fields, IDs, idempotency keys, indexes, and all retained catalog records. Earlier upgrades also remove the old schedule and credential tables. Back up an existing database before upgrading.

SQLite serializes writers; synchronous database work occupies the API event loop. This is not a multi-instance production architecture. Public hosting also requires operational planning and a database/concurrency review.

The shared calendar uses recurring same-day weekday intervals. Per-dealership service menus, individual technician rotas, dealership-specific hours, holiday exceptions, overnight shifts, bay equipment capabilities, cancellation/rescheduling, account registration, payments, and notifications are not implemented.

Databases, dependencies, builds, and test artifacts are gitignored. Back up a database using SQLite's backup mechanism, or stop all writers before copying it; do not copy only the main file while WAL writes are active. Schema upgrades reject newer unsupported versions. Back up before future destructive migrations; there is no automatic downgrade command.

See [ARCHITECTURE.md](ARCHITECTURE.md) for decisions and trade-offs.

Project conventions, naming rules, data-safety requirements, and agent workflow are in [AGENTS.md](AGENTS.md).
