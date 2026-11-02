import example from '../../../../configs/scope.example.json' with { type: 'json' };
export const scopeExample = example;

/** An example is only a draft. Any saved target, exclusion, network or service keeps the saved editor intact. */
export function initialScopeDraft(scope: Record<string, unknown>): string {
  const services = scope.services as Record<string, unknown> | undefined;
  const empty = ['targets', 'exclusions', 'networks'].every(key => Array.isArray(scope[key]) && scope[key].length === 0)
    && services && Object.values(services).every(value => Array.isArray(value) && value.length === 0);
  return JSON.stringify(empty ? example : scope, null, 2);
}
export function scopePreview(draft: string): string {
  try {
    const scope = JSON.parse(draft) as typeof example;
    if (!Array.isArray(scope.targets) || !Array.isArray(scope.exclusions) || !Array.isArray(scope.networks) || !scope.services) throw new Error('Use targets, exclusions, networks and services from the example.');
    const targets = scope.targets.map(rule => {
      if (typeof rule.host !== 'string' || !Array.isArray(rule.schemes) || !Array.isArray(rule.ports) || !Array.isArray(rule.pathPrefixes)) throw new Error('Each target needs a host-rule object with host, schemes, ports and pathPrefixes; a hostname string alone is invalid.');
      return `${rule.host}: ${rule.schemes.join('/')} · ports ${rule.ports.join(', ')} · paths ${rule.pathPrefixes.join(', ')}`;
    });
    return [...targets, `Excluded: ${scope.exclusions.join(', ') || 'none'}`, `Network grants: ${scope.networks.join(', ') || 'none'}`,
      'Exclusions take precedence. This draft becomes active only after Apply.'].join('\n');
  } catch (error) { return `Scope draft needs attention: ${error instanceof Error ? error.message : 'Invalid JSON'}`; }
}
