/**
 * Widget registry. `widgets/index.ts` fills it at module load; the host reads
 * it. Kept separate from the host so a widget's own test can register into a
 * throwaway registry without dragging the DOM host in.
 */

import type { WidgetDefinition } from "./widget-api.js";

export class WidgetRegistry {
  private defs = new Map<string, WidgetDefinition>();

  register(def: WidgetDefinition): void {
    if (this.defs.has(def.type)) {
      // Two widgets claiming one type is a build-time mistake, not a runtime
      // condition -- say so loudly rather than letting import order decide.
      throw new Error(`dashboard: widget type "${def.type}" is already registered`);
    }
    this.defs.set(def.type, def);
  }

  get(type: string): WidgetDefinition | undefined {
    return this.defs.get(type);
  }

  list(): WidgetDefinition[] {
    return [...this.defs.values()];
  }
}

/** The registry the shipped dashboard uses. */
export const widgetRegistry = new WidgetRegistry();

export function registerWidget(def: WidgetDefinition): void {
  widgetRegistry.register(def);
}
