import express, { type ErrorRequestHandler, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { listAppointments, getCustomerCatalog, type Store } from './persistence/database.js';
import { DomainError, Scheduler } from './scheduler.js';
import { customerSchema, httpBookingSchema, httpConfirmationSchema, httpSlotRequestSchema } from '../shared/contracts.js';

export type LogEntry = { requestId: string; operation: string; code: string; detail?: string };
type Options = {
  port?: number;
  now?: () => number;
  afterInsert?: () => void;
  logger?: (entry: LogEntry) => void;
  clientDirectory?: string;
};

function getSelectedProfileId(res: Response) {
  return z.string().parse(res.locals.customerId);
}

export function createApp(db: Store, options: Options = {}) {
  const app = express();
  app.disable('x-powered-by');
  const scheduler = new Scheduler(db, options.now, options.afterInsert);
  const logger = options.logger ?? (entry => console.log(JSON.stringify(entry)));
  const origins = new Set([3001, 5173, options.port ?? 3001]
    .flatMap(port => [`http://127.0.0.1:${port}`, `http://localhost:${port}`]));
  app.use((req, res, next) => {
    const requestId = randomUUID();
    res.locals.requestId = requestId;
    res.set({
      'X-Request-Id': requestId,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'",
    });
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(req.hostname)) {
      return next(new DomainError('INVALID_HOST', 'This application is available only on the local host.', 403));
    }
    if (req.path.startsWith('/api')) res.set('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (req.get('origin') && !origins.has(req.get('origin')!)) {
        return next(new DomainError('INVALID_ORIGIN', 'This request origin is not allowed.', 403));
      }
      if (!req.is('application/json')) {
        return next(new DomainError('JSON_REQUIRED', 'Send a JSON request body.', 415));
      }
    }
    next();
  });
  app.use(express.json({ limit: '16kb' }));
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/api/profiles', (_req, res) => res.json(
    z.array(customerSchema).parse(db.prepare('SELECT id, name FROM customers ORDER BY id').all()),
  ));
  app.use(['/api/catalog', '/api/appointments', '/api/availability'], (req, res, next) => {
    const id = req.get('X-Demo-Customer');
    if (!id) return next(new DomainError('PROFILE_REQUIRED', 'Choose a demo profile to continue.', 400));
    const customer = customerSchema.optional().parse(db.prepare('SELECT id, name FROM customers WHERE id = ?').get(id));
    if (!customer) return next(new DomainError('PROFILE_NOT_FOUND', 'That demo profile is no longer available. Choose another profile.', 400));
    // This client-selected header scopes a demo workflow; it is not authentication.
    res.locals.customerId = customer.id;
    res.set('X-Demo-Customer', customer.id);
    next();
  });
  app.get('/api/catalog', (_req, res) => res.json(getCustomerCatalog(db, getSelectedProfileId(res))));
  app.get('/api/appointments', (_req, res) => res.json(listAppointments(db, getSelectedProfileId(res))));
  app.post('/api/availability', (req, res) => res.json(scheduler.previewAvailability({
    ...httpBookingSchema.parse(req.body), customerId: getSelectedProfileId(res),
  })));
  app.post('/api/availability/slots', (req, res) => res.json(scheduler.getAvailabilityWindow({
    ...httpSlotRequestSchema.parse(req.body), customerId: getSelectedProfileId(res),
  })));
  app.post('/api/appointments', (req, res) => {
    const result = scheduler.confirmAppointment({ ...httpConfirmationSchema.parse(req.body), customerId: getSelectedProfileId(res) });
    logger({ requestId: res.locals.requestId, operation: 'confirm', code: result.replayed ? 'REPLAYED' : 'CONFIRMED' });
    res.status(result.replayed ? 200 : 201).json(result);
  });
  app.use('/api', (_req, _res, next) => next(new DomainError('NOT_FOUND', 'This API route does not exist.', 404)));
  if (options.clientDirectory) app.use(express.static(options.clientDirectory));
  const errorHandler: ErrorRequestHandler = (error: unknown, req, res, _next) => {
    let status = 500;
    let code = 'INTERNAL_ERROR';
    let message = 'The operation could not be completed. Retry with the same booking request.';
    if (error instanceof DomainError) {
      ({ status, code, message } = error);
    } else if (error instanceof z.ZodError) {
      status = 422;
      code = 'INVALID_REQUEST';
      message = error.issues.map(issue => `${issue.path.join('.') || 'request'}: ${issue.message}`).join('; ');
    } else if (error instanceof Error && 'code' in error && error.code === 'SQLITE_BUSY') {
      status = 503;
      code = 'DATABASE_BUSY';
      message = 'The booking service is busy. Please retry this same request.';
      res.set('Retry-After', '1');
    } else if (error instanceof Error && 'type' in error && error.type === 'entity.parse.failed') {
      status = 400;
      code = 'INVALID_JSON';
      message = 'The request body must be valid JSON.';
    } else if (error instanceof Error && 'type' in error && error.type === 'entity.too.large') {
      status = 413;
      code = 'REQUEST_TOO_LARGE';
      message = 'The request body is too large.';
    }
    const requestId = z.string().parse(res.locals.requestId);
    logger({
      requestId, operation: req.method === 'POST' && req.path === '/api/appointments' ? 'confirm' : 'request', code,
      ...(status === 500 && error instanceof Error ? { detail: error.message } : {}),
    });
    res.status(status).json({ error: { code, message, requestId } });
  };
  app.use(errorHandler);
  return app;
}
