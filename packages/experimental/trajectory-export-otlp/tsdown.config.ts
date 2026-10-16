/** Build the two logs entries and optional traces entry with shared private delivery code. */
import { defineConfig } from 'tsdown'

export default defineConfig({ entry: ['lib/types/index.js', 'lib/types/collector.js', 'lib/types/traces.js'] })
