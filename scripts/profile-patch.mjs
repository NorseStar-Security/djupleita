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

/** Fill introduced capabilities recursively, retaining saved mode choices and plugin settings. */
function introduce(existing, generated, retiredPersona) {
  if (isMap(existing) && isMap(generated)) {
    for (const pair of generated.items) {
      const key = pair.key.value;
      if (!existing.has(key)) existing.set(key, pair.value.clone());
      else if (key !== 'prefix') introduce(existing.get(key), pair.value, retiredPersona);
      else if (typeof existing.get(key) === 'string' && retiredPersona) {
        const previous = existing.get(key), suffix = `\n\n${retiredPersona}`;
        if (previous.endsWith(suffix)) existing.set(key, previous.slice(0, -suffix.length));
        else if (previous === retiredPersona) existing.set(key, pair.value.clone());
      }
    }
  } else if (isSeq(existing) && isSeq(generated)) {
    for (const row of generated.items) {
      if (!isMap(row) || !row.has('id')) continue;
      const current = existing.items.find(item => isMap(item) && item.get('id') === row.get('id'));
      if (current) introduce(current, row, retiredPersona);
      else existing.add(row.clone());
    }
  }
}

export function mergeProfilePatch(source, generated, retiredPersona) {
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
          for (const field of pair.value.items) {
            // The initial distribution default must not reset a saved base mode.
            if (patch.get('id') === 'agent-preset-registry' && field.key.value === 'default' && current.get(key).has('default')) continue;
            current.get(key).set(field.key.value, field.value);
          }
        } else current.set(key, pair.value);
      }
      continue;
    }
    for (const entry of patch.get('insert').items) {
      const current = doc.contents.items.flatMap(row => isMap(row) && isSeq(row.get('insert')) ? row.get('insert').items : [])
        .find(row => isMap(row) && row.get('id') === entry.get('id'));
      if (!current) {
        const inserted = doc.createNode({ insert: [] });
        inserted.get('insert').add(entry.clone());
        doc.contents.add(inserted); continue;
      }
      for (const pair of entry.items) {
        const key = pair.key.value;
        if (key === 'config' && entry.get('id').startsWith('preset-') && isMap(current.get(key))) {
          const plugins = current.get(key).get('plugins');
          if (isSeq(plugins)) {
            introduce(plugins, pair.value.get('plugins'), retiredPersona);
            continue;
          }
        }
        current.set(key, pair.value);
      }
    }
  }
  return doc.toString({ lineWidth: 0 });
}
