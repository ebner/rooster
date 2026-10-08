import type { Context, ErrorHandler, NotFoundHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ZodError } from 'zod';
import type { AppEnv } from './context.ts';
import { logSafeError } from './log-safe-error.ts';
import type { Logger } from './logger.ts';

export interface FieldError {
  path: string;
  message: string;
}

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: string;
  errors?: FieldError[];
  /** See `problemSchema.existingId` in @rooster/core. */
  existingId?: string;
}

/** RFC 9457 extension members a service may attach to a problem. */
export type ProblemExtensions = Pick<Problem, 'existingId'>;

/** Domain error thrown from services; rendered as problem+json with a stable `code`. */
export class AppError extends Error {
  readonly code: string;
  readonly status: ContentfulStatusCode;
  readonly detail: string;
  readonly errors: FieldError[] | undefined;
  readonly extensions: ProblemExtensions | undefined;

  constructor(
    code: string,
    status: ContentfulStatusCode,
    detail: string,
    errors?: FieldError[],
    extensions?: ProblemExtensions,
  ) {
    super(detail);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.detail = detail;
    this.errors = errors;
    this.extensions = extensions;
  }
}

const STATUS_TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  410: 'Gone',
  413: 'Content Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Content',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

const STATUS_CODES: Record<number, string> = {
  400: 'bad_request',
  401: 'unauthenticated',
  403: 'forbidden',
  404: 'not_found',
  405: 'method_not_allowed',
  409: 'conflict',
  410: 'gone',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  422: 'validation_failed',
  429: 'rate_limited',
  503: 'unavailable',
};

export function problemResponse(
  c: Context,
  status: ContentfulStatusCode,
  code: string,
  detail: string,
  errors?: FieldError[],
  extensions?: ProblemExtensions,
): Response {
  const body: Problem = {
    type: 'about:blank',
    title: STATUS_TITLES[status] ?? 'Error',
    status,
    detail,
    code,
    ...(errors === undefined ? {} : { errors }),
    ...extensions,
  };
  return c.body(JSON.stringify(body), status, { 'Content-Type': 'application/problem+json' });
}

export function zodFieldErrors(error: ZodError): FieldError[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}

export function validationProblem(c: Context, error: ZodError): Response {
  return problemResponse(
    c,
    422,
    'validation_failed',
    'The request did not pass validation.',
    zodFieldErrors(error),
  );
}

/** `defaultHook` for OpenAPIHono: every zod-openapi route reports validation errors uniformly. */
export function validationHook(
  result: { success: true } | { success: false; error: ZodError },
  c: Context,
): Response | undefined {
  return result.success ? undefined : validationProblem(c, result.error);
}

export const createErrorHandler =
  (baseLogger: Logger): ErrorHandler<AppEnv> =>
  (err, c) => {
    if (err instanceof AppError) {
      return problemResponse(c, err.status, err.code, err.detail, err.errors, err.extensions);
    }
    if (err instanceof ZodError) {
      return validationProblem(c, err);
    }
    if (err instanceof HTTPException && err.status < 500) {
      const status = err.status as ContentfulStatusCode;
      return problemResponse(
        c,
        status,
        STATUS_CODES[status] ?? 'http_error',
        err.message || 'Request failed.',
      );
    }
    // The request logger may not be attached yet if an early middleware threw.
    const logger = c.get('logger') ?? baseLogger;
    logger.error({ err: logSafeError(err), reqId: c.get('requestId') }, 'unhandled error');
    return problemResponse(c, 500, 'internal_error', 'An unexpected error occurred.');
  };

export const notFoundHandler: NotFoundHandler<AppEnv> = (c) =>
  problemResponse(c, 404, 'not_found', `No route for ${c.req.method} ${c.req.path}.`);
