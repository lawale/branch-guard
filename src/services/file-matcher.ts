import picomatch from "picomatch";

/**
 * Match file paths against include/exclude glob patterns.
 * Returns the subset of `files` that match at least one include pattern
 * and do not match any exclude pattern.
 */
export function matchFiles(
  files: string[],
  include: string[],
  exclude: string[] = [],
): string[] {
  const isIncluded = picomatch(include, { dot: true });
  const isExcluded = exclude.length > 0 ? picomatch(exclude, { dot: true }) : () => false;

  return files.filter((file) => isIncluded(file) && !isExcluded(file));
}

/**
 * Check whether any file in the list matches the include/exclude patterns.
 */
export function hasMatchingFiles(
  files: string[],
  include: string[],
  exclude: string[] = [],
): boolean {
  const isIncluded = picomatch(include, { dot: true });
  const isExcluded = exclude.length > 0 ? picomatch(exclude, { dot: true }) : () => false;

  return files.some((file) => isIncluded(file) && !isExcluded(file));
}
