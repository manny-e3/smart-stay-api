import { MockAdapter } from './mock.js';
import { HttpAdapter } from './http.js';

/** Vendor name (adapters.vendor column) -> adapter class. Add real vendor adapters here. */
export const VENDORS = {
  mock: MockAdapter,
  http: HttpAdapter,
};

const instances = new Map();

/** Returns an adapter instance for a row of the adapters table, rebuilt when the row changes. */
export function adapterFor(row) {
  const Impl = VENDORS[row.vendor];
  if (!Impl) throw new Error(`Unknown adapter vendor "${row.vendor}"`);
  const key = `${row.id}:${new Date(row.updated_at).getTime()}:${JSON.stringify(row.config ?? {})}`;
  const cached = instances.get(row.id);
  if (cached?.key === key) return cached.instance;
  const instance = new Impl(row);
  instances.set(row.id, { key, instance });
  return instance;
}
