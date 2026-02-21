import { Request, Response, NextFunction } from 'express';

interface RateLimitEntry {
  count: number;
  firstRequest: number;
  lastRequest: number;
}

interface RateLimiterConfig {
  windowMs: number;
  maxRequests: number;
  message?: string;
  skipSuccessfulRequests?: boolean;
  keyGenerator?: (req: Request) => string;
}

const rateLimitStore = new Map<string, RateLimitEntry>();

const CLEANUP_INTERVAL_MS = 60000;
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore.entries()) {
    if (now - entry.firstRequest > 300000) {
      rateLimitStore.delete(key);
    }
  }
}, CLEANUP_INTERVAL_MS);

function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    return forwarded.split(',')[0].trim();
  }
  if (Array.isArray(forwarded)) {
    return forwarded[0];
  }
  return req.socket?.remoteAddress || 'unknown';
}

export function createRateLimiter(config: RateLimiterConfig) {
  const {
    windowMs,
    maxRequests,
    message = 'Too many requests, please try again later.',
    keyGenerator = (req) => getClientIp(req),
  } = config;

  return (req: Request, res: Response, next: NextFunction) => {
    const key = keyGenerator(req);
    const now = Date.now();
    
    let entry = rateLimitStore.get(key);
    
    if (!entry || (now - entry.firstRequest) > windowMs) {
      entry = { count: 1, firstRequest: now, lastRequest: now };
      rateLimitStore.set(key, entry);
      
      res.setHeader('X-RateLimit-Limit', maxRequests.toString());
      res.setHeader('X-RateLimit-Remaining', (maxRequests - 1).toString());
      res.setHeader('X-RateLimit-Reset', Math.ceil((entry.firstRequest + windowMs) / 1000).toString());
      
      return next();
    }
    
    entry.count++;
    entry.lastRequest = now;
    
    const remaining = Math.max(0, maxRequests - entry.count);
    res.setHeader('X-RateLimit-Limit', maxRequests.toString());
    res.setHeader('X-RateLimit-Remaining', remaining.toString());
    res.setHeader('X-RateLimit-Reset', Math.ceil((entry.firstRequest + windowMs) / 1000).toString());
    
    if (entry.count > maxRequests) {
      const retryAfter = Math.ceil((entry.firstRequest + windowMs - now) / 1000);
      res.setHeader('Retry-After', retryAfter.toString());
      
      console.warn(`[RATE LIMIT] Blocked request from ${key} - ${entry.count}/${maxRequests} in window`);
      
      return res.status(429).json({
        error: message,
        retryAfter,
      });
    }
    
    next();
  };
}

export const apiRateLimiter = createRateLimiter({
  windowMs: 60000,
  maxRequests: 100,
  message: 'Too many API requests, please try again later.',
});

export const authRateLimiter = createRateLimiter({
  windowMs: 900000,
  maxRequests: 10,
  message: 'Too many login attempts, please try again in 15 minutes.',
});

export const webhookRateLimiter = createRateLimiter({
  windowMs: 60000,
  maxRequests: 500,
  message: 'Too many webhook requests.',
  keyGenerator: (req) => `${req.path}:${getClientIp(req)}`,
});
