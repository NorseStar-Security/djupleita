/** Load the real memory plugin in the selected source or artifact plane. */
const plane = process.env.DSH_EXAMPLE_MODE === 'lib' ? 'lib/index.js' : 'src/index.ts'
export const { default: defaultPlugin } = await import(new URL(`../../../packages/experimental/assessment-memory/${plane}`, import.meta.url).href)
export default defaultPlugin
