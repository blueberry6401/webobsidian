import type { Request, Response, NextFunction } from 'express';

/** Wrap async route handlers so rejections hit the error middleware. */
export function asyncHandler<T>(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<T>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction): void {
  const status = err?.status ?? 500;
  if (status >= 500) console.error('[error]', err);
  res.status(status).json({ error: err?.message ?? 'Internal Server Error' });
}
