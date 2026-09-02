/**
 * Minimal structural types for the `pg` module.
 * The pg package is loaded via createRequire for CJS interop, so these
 * interfaces give us type safety without a hard dependency on @types/pg.
 */

export interface PgQueryResult<R = Record<string, unknown>> {
  rows: R[];
}

export interface PgPool {
  query(text: string, params?: unknown[]): Promise<PgQueryResult>;
  end(): Promise<void>;
}

export interface PgPoolConfig {
  connectionString?: string;
  max?: number;
  connectionTimeoutMillis?: number;
  idleTimeoutMillis?: number;
  application_name?: string;
}

export type PgPoolConstructor = new (config: PgPoolConfig) => PgPool;

/** Shape of `require('pg')` — cast the createRequire result to this. */
export interface PgModule {
  Pool: PgPoolConstructor;
}
