/** Select the same source/artifact plane as the snapshot launcher. */
const plane = process.env.DSH_EXAMPLE_MODE === 'lib' ? 'lib/index.js' : 'src/index.ts'
const plugin = await import(new URL(`../../../packages/experimental/security-callbacks-tools/${plane}`, import.meta.url).href)
export const name = plugin.name
export const inject = plugin.inject
export const apply = plugin.apply
