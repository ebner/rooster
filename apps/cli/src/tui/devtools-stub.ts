/**
 * Stands in for `react-devtools-core`, which Ink imports for `DEV=true` debugging only. Bundling
 * this no-op instead of leaving an external keeps Bun's compiled binaries from trying to resolve
 * the package at startup (ADR 0047).
 */
const devtools = {
  initialize(): void {},
  connectToDevTools(): void {},
};
export default devtools;
