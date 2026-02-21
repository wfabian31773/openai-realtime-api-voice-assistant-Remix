import { Request, Response, NextFunction } from 'express';

export function noCacheHeaders(req: Request, res: Response, next: NextFunction) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  next();
}

export function apiCacheHeaders(maxAge: number = 0) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (maxAge > 0) {
      res.setHeader('Cache-Control', `public, max-age=${maxAge}`);
    } else {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
    }
    next();
  };
}

export function staticAssetCacheHeaders(maxAge: number = 86400) {
  return (req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', `public, max-age=${maxAge}, immutable`);
    next();
  };
}
