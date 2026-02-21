import { Request, Response, NextFunction } from 'express';
import twilio from 'twilio';
import { getEnvironmentConfig } from '../config/environment';

const BYPASS_VALIDATION = process.env.BYPASS_TWILIO_VALIDATION === 'true';

export function validateTwilioWebhook(req: Request, res: Response, next: NextFunction) {
  if (BYPASS_VALIDATION) {
    console.warn('[TWILIO VALIDATION] ⚠️ Validation bypassed (BYPASS_TWILIO_VALIDATION=true)');
    return next();
  }

  const envConfig = getEnvironmentConfig();
  const authToken = envConfig.twilio.authToken;
  
  if (!authToken) {
    console.error('[TWILIO VALIDATION] ✗ No auth token configured');
    return res.status(500).send('<Response><Say>Configuration error</Say></Response>');
  }

  const twilioSignature = req.headers['x-twilio-signature'] as string;
  
  if (!twilioSignature) {
    console.warn('[TWILIO VALIDATION] ✗ Missing X-Twilio-Signature header');
    return res.status(403).send('<Response><Say>Invalid request</Say></Response>');
  }

  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const url = `${protocol}://${host}${req.originalUrl}`;
  
  let params: Record<string, string> = {};
  if (req.body) {
    const bodyString = req.body.toString('utf8');
    if (bodyString) {
      params = Object.fromEntries(new URLSearchParams(bodyString));
    }
  }

  const isValid = twilio.validateRequest(
    authToken,
    twilioSignature,
    url,
    params
  );

  if (!isValid) {
    console.warn(`[TWILIO VALIDATION] ✗ Invalid signature for ${req.path}`);
    console.warn(`[TWILIO VALIDATION]   URL: ${url}`);
    console.warn(`[TWILIO VALIDATION]   Signature: ${twilioSignature?.substring(0, 20)}...`);
    
    return res.status(403).send('<Response><Say>Invalid request signature</Say></Response>');
  }

  next();
}

export function optionalTwilioValidation(req: Request, res: Response, next: NextFunction) {
  const twilioSignature = req.headers['x-twilio-signature'];
  
  if (!twilioSignature) {
    return next();
  }
  
  return validateTwilioWebhook(req, res, next);
}
