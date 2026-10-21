import { z } from 'zod';
import { errorSchema } from '../shared/contracts.js';

export class ApiError extends Error {
  constructor(message: string, public code: string, public status: number) { super(message); }
}

export async function requestApi<T>(path: string, schema: z.ZodType<T>, body?: unknown, customerId?: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(customerId ? { 'X-Demo-Customer': customerId } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError('The service could not be reached. If you were confirming, retry the same request.', 'NETWORK_ERROR', 0);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError('The service returned an unreadable response. Retry the same request if you were confirming.', 'INVALID_RESPONSE', 0);
  }
  if (!response.ok) {
    const parsed = errorSchema.safeParse(payload);
    if (parsed.success && ['PROFILE_REQUIRED', 'PROFILE_NOT_FOUND'].includes(parsed.data.error.code)) {
      window.dispatchEvent(new CustomEvent('profile-unavailable', { detail: { customerId } }));
    }
    throw new ApiError(parsed.success ? parsed.data.error.message : 'The service could not complete this request.',
      parsed.success ? parsed.data.error.code : 'SERVER_ERROR', response.status);
  }
  if (customerId && response.headers.get('X-Demo-Customer') !== customerId) {
    throw new ApiError('The service returned a result for a different profile. Please retry the same request.', 'INVALID_RESPONSE', 0);
  }
  const result = schema.safeParse(payload);
  if (!result.success) throw new ApiError('The service response was incomplete. Please retry the same request.', 'INVALID_RESPONSE', 0);
  return result.data;
}
