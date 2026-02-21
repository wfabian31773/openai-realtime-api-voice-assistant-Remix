type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogContext {
  callId?: string;
  conferenceName?: string;
  agentSlug?: string;
  twilioCallSid?: string;
  event?: string;
  duration?: number;
  error?: string;
  [key: string]: unknown;
}

interface StructuredLogEntry {
  timestamp: string;
  level: LogLevel;
  component: string;
  message: string;
  context: LogContext;
}

class StructuredLogger {
  private component: string;
  private static globalContext: Record<string, unknown> = {};

  constructor(component: string) {
    this.component = component;
  }

  static setGlobalContext(ctx: Record<string, unknown>): void {
    StructuredLogger.globalContext = { ...StructuredLogger.globalContext, ...ctx };
  }

  private formatLog(level: LogLevel, message: string, context: LogContext = {}): string {
    const entry: StructuredLogEntry = {
      timestamp: new Date().toISOString(),
      level,
      component: this.component,
      message,
      context: { ...StructuredLogger.globalContext, ...context },
    };

    const contextStr = Object.keys(entry.context).length > 0 
      ? ` ${JSON.stringify(entry.context)}`
      : '';
    
    return `[${entry.timestamp}] [${entry.level.toUpperCase()}] [${entry.component}] ${message}${contextStr}`;
  }

  debug(message: string, context?: LogContext): void {
    if (process.env.LOG_LEVEL === 'debug') {
      console.log(this.formatLog('debug', message, context));
    }
  }

  info(message: string, context?: LogContext): void {
    console.info(this.formatLog('info', message, context));
  }

  warn(message: string, context?: LogContext): void {
    console.warn(this.formatLog('warn', message, context));
  }

  error(message: string, context?: LogContext): void {
    console.error(this.formatLog('error', message, context));
  }

  callStateTransition(callId: string, from: string, to: string, context?: LogContext): void {
    this.info(`Call state: ${from} -> ${to}`, { 
      callId, 
      event: 'state_transition',
      fromState: from,
      toState: to,
      ...context 
    });
  }

  callStarted(context: { callId?: string; conferenceName?: string; agentSlug?: string; callerPhone?: string }): void {
    this.info('Call started', { ...context, event: 'call_started' });
  }

  callEnded(context: { callId?: string; conferenceName?: string; duration?: number; endReason?: string }): void {
    this.info('Call ended', { ...context, event: 'call_ended' });
  }

  handoffInitiated(context: { callId?: string; targetNumber?: string; reason?: string }): void {
    this.info('Human handoff initiated', { ...context, event: 'handoff_initiated' });
  }

  handoffCompleted(context: { callId?: string; success: boolean; duration?: number }): void {
    this.info('Human handoff completed', { ...context, event: 'handoff_completed' });
  }

  ticketCreated(context: { callId?: string; ticketId?: string; ticketType?: string }): void {
    this.info('Ticket created', { ...context, event: 'ticket_created' });
  }

  apiError(context: { callId?: string; api: string; error: string; statusCode?: number }): void {
    this.error(`API error: ${context.api}`, { ...context, event: 'api_error' });
  }

  circuitBreakerStateChange(name: string, from: string, to: string): void {
    this.warn(`Circuit breaker state change: ${name}`, { 
      event: 'circuit_breaker_change',
      circuitName: name,
      fromState: from,
      toState: to,
    });
  }

  retryAttempt(context: { operation: string; attempt: number; maxAttempts: number; error?: string }): void {
    this.warn(`Retry attempt ${context.attempt}/${context.maxAttempts}: ${context.operation}`, {
      event: 'retry_attempt',
      ...context,
    });
  }
}

export function createLogger(component: string): StructuredLogger {
  return new StructuredLogger(component);
}

export const callLogger = createLogger('CALL');
export const webhookLogger = createLogger('WEBHOOK');
export const ticketingLogger = createLogger('TICKETING');
export const resilienceLogger = createLogger('RESILIENCE');
