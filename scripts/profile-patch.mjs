/** Refresh distribution-owned rows without erasing settings saved by DSH's UI. */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(fileURLToPath(new URL('../vendor/deepseek-harness/packages/boot/config-editor/package.json', import.meta.url)));
const { parseDocument, isMap, isSeq } = require('yaml');

function document(source) {
  const doc = parseDocument(source, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] });
  if (doc.errors.length || !isSeq(doc.contents)) throw new Error('Profile patch must be a valid YAML sequence; the existing file has been left unchanged.');
  return doc;
}

export function mergeProfilePatch(source, generated) {
  const doc = document(source), managed = document(generated);
  doc.contents.flow = false;
  for (const patch of managed.contents.items) {
    if (!patch.has('insert')) {
      const current = doc.contents.items.findLast(row => isMap(row) && row.get('id') === patch.get('id') && !row.has('insert'));
      if (!current) { doc.contents.add(patch); continue; }
      // Keep other settings on the same service (for example selectedDefault).
      for (const pair of patch.items) {
        const key = pair.key.value;
        if (key === 'config' && isMap(current.get(key)) && isMap(pair.value)) {
          for (const field of pair.value.items) current.get(key).set(field.key.value, field.value);
        } else current.set(key, pair.value);
      }
      continue;
    }
    for (const entry of patch.get('insert').items) {
      const current = doc.contents.items.flatMap(row => isMap(row) && isSeq(row.get('insert')) ? row.get('insert').items : [])
        .find(row => isMap(row) && row.get('id') === entry.get('id'));
      if (!current) { doc.contents.add(doc.createNode({ insert: [entry.toJSON()] })); continue; }
      for (const pair of entry.items) {
        const key = pair.key.value;
        if (key === 'config' && entry.get('id') === 'preset-pentest' && isMap(current.get(key))) {
          const plugins = current.get(key).get('plugins');
          if (isSeq(plugins)) {
            for (const plugin of pair.value.get('plugins').items) {
              if (!plugins.items.some(row => isMap(row) && row.get('id') === plugin.get('id'))) plugins.add(plugin);
            }
            continue;
          }
        }
        current.set(key, pair.value);
      }
    }
  }
  return doc.toString({ lineWidth: 0 });
}
