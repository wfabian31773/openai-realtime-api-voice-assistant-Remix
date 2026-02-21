declare module "connect-pg-simple" {
  import session from "express-session";
  import { Pool } from "pg";

  interface PGStoreOptions {
    pool?: Pool;
    conString?: string;
    conObject?: object;
    tableName?: string;
    schemaName?: string;
    ttl?: number;
    disableTouch?: boolean;
    createTableIfMissing?: boolean;
    pruneSessionInterval?: number | false;
    errorLog?: (...args: any[]) => void;
  }

  function connectPgSimple(
    session: typeof import("express-session")
  ): new (options?: PGStoreOptions) => session.Store;

  export = connectPgSimple;
}
