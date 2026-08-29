import pkg from "../../package.json";

// Single source of truth: package.json. Bun inlines this at compile time,
// so release binaries self-report the version they were built from.
export const VERSION: string = pkg.version;
