# Load Testing & Connection Pooling - Azul Vision

## Overview
This document outlines load testing requirements and database connection pooling configuration for handling 20+ concurrent calls.

---

## Target Capacity

| Metric | Target | Notes |
|--------|--------|-------|
| Concurrent calls | 20+ | OpenAI Realtime API limit per project |
| Calls per hour | 200+ | Peak afternoon hours |
| Database connections | 25 max | Supabase connection limit |
| API requests/min | 500+ | Dashboard + webhooks + sync jobs |

---

## Database Connection Pooling

### Supabase (Production)
```
Connection URL: postgresql://[user]:[pass]@[host]:6543/[db]?sslmode=require

Port 6543 = Transaction pooler (recommended)
Port 5432 = Direct connection (use sparingly)
```

### Pool Configuration
```typescript
// Recommended settings for 20+ concurrent calls
const pool = new Pool({
  connectionString: process.env.SUPABASE_URL,
  max: 20,                    // Maximum pool size
  idleTimeoutMillis: 30000,   // Close idle connections after 30s
  connectionTimeoutMillis: 10000, // Fail connection after 10s
});
```

### Pool Monitoring
Check pool health via `/healthz` endpoint:
```json
{
  "database": "healthy",
  "poolStats": {
    "total": 20,
    "idle": 15,
    "waiting": 0
  }
}
```

---

## Rate Limiting Configuration

### Current Limits (In-Memory Store)
| Endpoint Type | Limit | Window |
|---------------|-------|--------|
| API endpoints | 100 | 1 minute |
| Webhooks (Twilio) | 500 | 1 minute |
| Auth endpoints | 10 | 15 minutes |

### Production Upgrade Path
For horizontal scaling, replace in-memory store with Redis/Upstash:
```typescript
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

const ratelimit = new Ratelimit({
  redis: Redis.fromEnv(),
  limiter: Ratelimit.slidingWindow(100, '1 m'),
});
```

---

## Load Testing Scenarios

### Scenario 1: Concurrent Inbound Calls
```
Target: 20 simultaneous calls
Duration: 5 minutes average per call
Expected: All calls complete without timeout

Test command (using Twilio test calls):
- Configure 20 test phone numbers
- Initiate calls within 30-second window
- Monitor /api/call-monitor for all calls active
```

### Scenario 2: Webhook Storm
```
Target: 500 webhooks in 1 minute
Types: conference-events, recording-status
Expected: No 429 responses, all processed within 5s

Test command:
for i in {1..500}; do
  curl -X POST https://[domain]/api/voice/conference-events \
    -d "ConferenceSid=test_$i&StatusCallbackEvent=participant-join" &
done
```

### Scenario 3: Database Stress
```
Target: 100 call log queries in 10 seconds
Expected: P95 response < 500ms

Test command:
ab -n 100 -c 10 https://[domain]/api/call-logs?page=1
```

---

## Monitoring During Load Tests

### Key Metrics to Watch
1. **Response times** - P50, P95, P99
2. **Error rates** - 4xx, 5xx responses
3. **Database pool** - Active vs idle connections
4. **Memory usage** - Should stay < 80% of allocated
5. **Twilio queue depth** - Webhook delivery delays

### Alert Thresholds
| Metric | Warning | Critical |
|--------|---------|----------|
| Response time P95 | > 2s | > 5s |
| Error rate | > 1% | > 5% |
| DB pool exhausted | 80% | 100% |
| Memory | 70% | 85% |

---

## Pre-Production Checklist

- [ ] Database using port 6543 (transaction pooler)
- [ ] Connection pool size set to 20
- [ ] Rate limiter configured (upgrade to Redis for multi-instance)
- [ ] Twilio webhook validation enabled (BYPASS_TWILIO_VALIDATION unset)
- [ ] Alert service configured (URGENT_NOTIFICATION_NUMBER set)
- [ ] Load test completed with 10+ concurrent calls
- [ ] P95 response times under 2 seconds confirmed

---

## Scaling Considerations

### Single Instance (Current)
- In-memory rate limiter OK
- Database pool up to 20 connections
- Handles ~15 concurrent calls comfortably

### Multi-Instance (Future)
- Redis/Upstash for distributed rate limiting
- Reduce per-instance pool to 10 (shared limit)
- Session stickiness or stateless design
- Consider separate workers for background jobs

---

## Emergency Procedures

### Under Load Issues

1. **High latency**
   - Check database pool status
   - Review slow query logs
   - Temporarily disable non-critical background jobs

2. **Connection exhausted**
   - Increase pool size temporarily
   - Kill idle transactions
   - Scale horizontally if persistent

3. **Webhook backlog**
   - Twilio will retry automatically
   - Consider queue-based processing for spikes
