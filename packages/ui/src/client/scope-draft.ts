import example from '../../../../configs/scope.example.json' with { type: 'json' };
export const scopeExample = example;

/** Fill missing targets in the draft without changing saved targets or service/network settings. */
export function initialScopeDraft(scope: Record<string, unknown>): string {
  if (scope.targets !== undefined && (!Array.isArray(scope.targets) || scope.targets.length > 0)) return JSON.stringify(scope, null, 2);
  const emptyBoundary = ['exclusions', 'networks'].every(key => scope[key] === undefined || Array.isArray(scope[key]) && scope[key].length === 0);
  return JSON.stringify({ ...example, ...scope, targets: example.targets,
    enabled: scope.enabled ?? (scope.targets === undefined ? example.enabled : true),
    ...(emptyBoundary ? { exclusions: example.exclusions } : {}),
    services: { ...example.services, ...(scope.services as Record<string, unknown> | undefined) },
  }, null, 2);
}
export function scopePreview(draft: string): string {
  try {
    const scope = JSON.parse(draft) as typeof example;
    if (scope.enabled !== undefined && typeof scope.enabled !== 'boolean') throw new Error('enabled must be true or false.');
    if (!Array.isArray(scope.targets) || !Array.isArray(scope.exclusions) || !Array.isArray(scope.networks) || !scope.services) throw new Error('Use targets, exclusions, networks and services from the example.');
    const targets = scope.targets.map(rule => {
      if (typeof rule.host !== 'string' || !Array.isArray(rule.schemes) || !Array.isArray(rule.ports) || !Array.isArray(rule.pathPrefixes)) throw new Error('Each target needs a host-rule object with host, schemes, ports and pathPrefixes; a hostname string alone is invalid.');
      return `${rule.host}: ${rule.schemes.join('/')} · ports ${rule.ports.join(', ')} · paths ${rule.pathPrefixes.join(', ')}`;
    });
    return [`Scope management: ${scope.enabled === false ? 'OFF · target boundaries are not enforced' : 'ON · active testing requires target authorization'}`, ...targets, `Excluded: ${scope.exclusions.join(', ') || 'none'}`, `Network grants: ${scope.networks.join(', ') || 'none'}`,
      'Ordinary web reads and passive research may use unlisted sites. Target rules, exclusions and target network boundaries apply only when scope management is on. This draft becomes active only after Apply.'].join('\n');
  } catch (error) { return `Scope draft needs attention: ${error instanceof Error ? error.message : 'Invalid JSON'}`; }
}
