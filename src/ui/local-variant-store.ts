// ============================================================================
// ui/local-variant-store.ts
//
// Browser-only. `rules.ts` is shared with the server, so anything reaching
// for `localStorage` has to live on this side of the line.
// ============================================================================

import {
  exportVariant,
  importVariant,
  type VariantDef,
  type VariantStore,
} from "../rules.ts";

export class LocalVariantStore implements VariantStore {
  private prefix: string;

  constructor(prefix = "pond.variant.") {
    this.prefix = prefix;
  }

  async list(): Promise<VariantDef[]> {
    const out: VariantDef[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith(this.prefix)) continue;
      try {
        out.push(importVariant(localStorage.getItem(k)!));
      } catch {
        // Skip corrupt entries rather than breaking the whole variant list.
      }
    }
    return out;
  }

  async save(v: VariantDef): Promise<void> {
    localStorage.setItem(this.prefix + v.id, exportVariant(v));
  }

  async delete(id: string): Promise<void> {
    localStorage.removeItem(this.prefix + id);
  }
}
