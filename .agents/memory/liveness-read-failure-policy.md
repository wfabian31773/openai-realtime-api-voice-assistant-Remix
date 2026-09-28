---
name: Liveness read failure policy
description: Operator decision on failed heartbeat reads versus genuine outage emails.
---
Do not email ticketing-app outage or recovery alerts solely because the heartbeat reader cannot connect. Log the monitoring failure and preserve the last observed outage conditions.

**Why:** The operator explicitly requested stopping false emails from a misconfigured watcher, without disabling real outage alerts.

**How to apply:** A failed read means app health is unknown, not healthy or down. Successful reads must still evaluate stale heartbeat, memory, and event-loop conditions normally.