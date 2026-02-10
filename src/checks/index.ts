import type { CheckType } from "../types.js";

const registry = new Map<string, CheckType>();

/**
 * Register a check type implementation.
 * Called during app initialization.
 */
export function registerCheck(check: CheckType): void {
  registry.set(check.name, check);
}

/**
 * Get a check type implementation by name.
 * Throws if the check type is not registered.
 */
export function getCheck(type: string): CheckType {
  const check = registry.get(type);
  if (!check) {
    throw new Error(`Unknown check type: ${type}`);
  }
  return check;
}

/**
 * Get all registered check type names.
 */
export function getRegisteredCheckTypes(): string[] {
  return Array.from(registry.keys());
}
