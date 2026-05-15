import { z } from "zod";

/**
 * Accepts UUID strings or common client shapes (`{ value }`, `{ id }`) from searchable selects.
 * Invalid entries are dropped so one bad value does not fail the whole PATCH.
 */
export const zCatalogUuidArray = () =>
  z.preprocess((val) => {
    if (val === undefined || val === null) return undefined;
    if (!Array.isArray(val)) return val;
    const out: string[] = [];
    for (const item of val) {
      let s: string | undefined;
      if (typeof item === "string") s = item.trim();
      else if (typeof item === "number" && Number.isFinite(item)) s = String(item);
      else if (item && typeof item === "object") {
        const o = item as Record<string, unknown>;
        if (typeof o.value === "string") s = o.value.trim();
        else if (typeof o.id === "string") s = o.id.trim();
      }
      if (s && z.string().uuid().safeParse(s).success) out.push(s);
    }
    return out;
  }, z.array(z.string().uuid()).optional());
