---
name: Ticketing-app liveness watcher removed
description: Superseding operator decision to remove the watcher and its emails entirely.
---
The operator explicitly requested removal of the ticketing-app liveness watcher entirely. This supersedes the earlier policy about handling failed heartbeat reads: there is no watcher to read, schedule, or send outage/recovery emails.

Do not restore the watcher or its email types unsolicited. The independent ticket-filing alarm and other alerts are not part of this decision.