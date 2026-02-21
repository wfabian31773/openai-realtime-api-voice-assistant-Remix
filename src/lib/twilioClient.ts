// Twilio client using environment variables
// Falls back to Replit Twilio Integration if env vars not set

import twilio from 'twilio';

let connectionSettings: any;

async function getCredentialsFromConnector() {
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY
    ? 'repl ' + process.env.REPL_IDENTITY
    : process.env.WEB_REPL_RENEWAL
    ? 'depl ' + process.env.WEB_REPL_RENEWAL
    : null;

  if (!xReplitToken) {
    throw new Error('X_REPLIT_TOKEN not found for repl/depl');
  }

  connectionSettings = await fetch(
    'https://' + hostname + '/api/v2/connection?include_secrets=true&connector_names=twilio',
    {
      headers: {
        'Accept': 'application/json',
        'X_REPLIT_TOKEN': xReplitToken
      }
    }
  ).then(res => res.json()).then(data => data.items?.[0]);

  if (!connectionSettings || (!connectionSettings.settings.account_sid || !connectionSettings.settings.api_key || !connectionSettings.settings.api_key_secret)) {
    throw new Error('Twilio not connected');
  }
  
  return {
    accountSid: connectionSettings.settings.account_sid,
    apiKey: connectionSettings.settings.api_key,
    apiKeySecret: connectionSettings.settings.api_key_secret,
    phoneNumber: connectionSettings.settings.phone_number
  };
}

async function getCredentials() {
  // Use environment variables if set (direct credentials)
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
    return {
      accountSid: process.env.TWILIO_ACCOUNT_SID,
      authToken: process.env.TWILIO_AUTH_TOKEN,
      phoneNumber: process.env.TWILIO_PHONE_NUMBER
    };
  }
  
  // Otherwise try Replit connector integration
  return getCredentialsFromConnector();
}

export async function getTwilioClient() {
  const credentials = await getCredentials();
  
  // Use API key if available (from connector), otherwise use auth token (from env vars)
  if ('apiKey' in credentials && 'apiKeySecret' in credentials) {
    return twilio(credentials.apiKey, credentials.apiKeySecret, {
      accountSid: credentials.accountSid
    });
  } else {
    return twilio(credentials.accountSid, credentials.authToken);
  }
}

export async function getTwilioFromPhoneNumber() {
  const { phoneNumber } = await getCredentials();
  return phoneNumber;
}

export async function getTwilioAccountSid() {
  const { accountSid } = await getCredentials();
  return accountSid;
}
