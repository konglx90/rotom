/**
 * Backwards-compatible facade for the database layer.
 *
 * The implementation has moved into `./db/`:
 *   • `./db/types.ts`   — Row interfaces (no better-sqlite3 import)
 *   • `./db/internal.ts` — MeshDb runtime class (currently still monolithic;
 *                          method-by-method extraction lands in follow-up PRs)
 *   • `./db/index.ts`   — Public surface
 *
 * Existing callers (`import { MeshDb } from "../db.js"`) continue to work.
 */

export * from "./db/index.js";