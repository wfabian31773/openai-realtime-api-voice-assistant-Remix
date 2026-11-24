/**
 * The one lock every on-call rotation write takes: the admin page's
 * transactions (server/onCallAdmin/store.ts) and every transaction the CLI
 * prints (seed.ts, for scripts/on-call-change.ts and scripts/on-call-seed.ts).
 * Taken straight after BEGIN, before anything is read or checked, so a change
 * from one side can never land between the other's read of a row and its
 * write, and no audit row records a stale "before". Transaction-scoped:
 * released at COMMIT or ROLLBACK, so it is safe through PgBouncer's
 * transaction pooler. No semicolon: callers that print SQL add one.
 */
export const ON_CALL_ADMIN_WRITE_LOCK_SQL = `select pg_advisory_xact_lock(hashtext('on_call_admin_write'))`;
