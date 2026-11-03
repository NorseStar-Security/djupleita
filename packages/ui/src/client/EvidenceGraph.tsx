/** Engagement-wide explorer, shared by the conversation tab and plugin panel. */
import { useEffect, useState } from 'react';
import type { GraphNode, GraphEdge } from '../../../graph/src/index.ts';
import type { Evidence } from '../../../contracts/src/index.ts';
import css from './EvidenceGraph.module.css';

interface Browse {
  nodes: GraphNode[]; total: number; counts: { nodes: number; edges: number; evidence: number };
  types: { name: string; count: number }[]; collections: { name: string; count: number }[];
  offset: number; nextOffset: number | null;
}
interface Detail {
  node: GraphNode; nodes: GraphNode[]; edges: GraphEdge[]; evidence: Evidence[]; evidenceTotal: number;
  total: number; offset: number; nextOffset: number | null;
}
interface Props {
  engagement: { name: string; scope: { targets: { host: string }[] } };
  revision: string;
  inspect<T>(endpoint: string, payload: Record<string, unknown>): Promise<T>;
}
const pretty = (value: unknown): string => JSON.stringify(value, null, 2);
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

function RelationshipMap({ detail, focus }: { detail: Detail; focus(id: string): void }) {
  const neighbors = detail.nodes.slice(0, 6);
  const height = Math.max(240, neighbors.length * 62 + 24), center = height / 2;
  return <div className={css.map}>
    <svg viewBox={`0 0 800 ${height}`} aria-label={`Relationships for ${detail.node.name}`}>
      {neighbors.map((node, i) => {
        const edge = detail.edges.find(edge => edge.source === node.id || edge.target === node.id)!;
        const outgoing = edge.source === detail.node.id;
        const y = 42 + i * 62;
        return <g key={node.id}>
          <path d={`M 260 ${center} C 340 ${center}, 350 ${y}, 430 ${y}`} fill="none" className={css.link}
            data-status={edge.status} />
          <text x="344" y={y - 8} textAnchor="middle" className={css.edgeLabel}>{outgoing ? '→' : '←'} {edge.type.slice(0, 19)}</text>
          <g role="button" tabIndex={0} aria-label={`Focus ${node.name}`} onClick={() => focus(node.id)}
            onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); focus(node.id); } }}>
            <title>{node.name}</title><rect x="430" y={y - 25} width="350" height="50" rx="9" className={css.node} />
            <text x="444" y={y - 7} className={css.nodeType}>{node.type}</text>
            <text x="444" y={y + 12} className={css.nodeName}>{node.name.length > 43 ? `${node.name.slice(0, 42)}…` : node.name}</text>
          </g>
        </g>;
      })}
      <rect x="20" y={center - 35} width="240" height="70" rx="10" className={css.focusNode} />
      <text x="36" y={center - 10} className={css.nodeType}>{detail.node.type}</text>
      <text x="36" y={center + 14} className={css.nodeName}>{detail.node.name.length > 28 ? `${detail.node.name.slice(0, 27)}…` : detail.node.name}</text>
    </svg>
    <p className={css.hint}>Showing {neighbors.length} connected nodes from this relationship page. Select a node to follow it.</p>
    <div className={css.legend}><span>— Observed</span><span>┄ Inferred</span><span data-status="verified">— Verified</span></div>
  </div>;
}

export function EvidenceGraph({ engagement, revision, inspect }: Props) {
  const [query, setQuery] = useState(''), [type, setType] = useState(''), [collection, setCollection] = useState('');
  const [offset, setOffset] = useState(0), [selected, setSelected] = useState<string>(), [relationOffset, setRelationOffset] = useState(0);
  const [page, setPage] = useState<Browse>(), [detail, setDetail] = useState<Detail>();
  const [busy, setBusy] = useState(true), [detailBusy, setDetailBusy] = useState(false), [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true; setBusy(true); setError('');
    const timer = setTimeout(() => {
      void inspect<Browse>('graph/explore', { query, type, collection, offset }).then(value => {
        if (!active) return;
        setPage(value); setSelected(current => current ?? value.nodes[0]?.id);
      }).catch(reason => { if (active) setError(message(reason)); }).finally(() => { if (active) setBusy(false); });
    }, 180);
    return () => { active = false; clearTimeout(timer); };
  }, [query, type, collection, offset, revision, refresh, inspect]);
  useEffect(() => {
    if (!selected) { setDetail(undefined); return; }
    let active = true; setDetailBusy(true); setDetail(undefined);
    void inspect<Detail>('graph/neighborhood', { nodeId: selected, offset: relationOffset }).then(value => {
      if (active) setDetail(value);
    }).catch(reason => { if (active) setError(message(reason)); }).finally(() => { if (active) setDetailBusy(false); });
    return () => { active = false; };
  }, [selected, relationOffset, revision, refresh, inspect]);
  const filter = (update: () => void): void => { update(); setOffset(0); setSelected(undefined); setDetail(undefined); setPage(undefined); setRelationOffset(0); };
  const focus = (id: string): void => { setSelected(id); setRelationOffset(0); setError(''); };
  return <section className={css.explorer} aria-label="Evidence graph explorer" aria-busy={busy || detailBusy}>
    <header className={css.header}><div><small>ENGAGEMENT EVIDENCE</small><h2>Evidence graph</h2>
      <p>{engagement.name} · Shared across chats</p></div><button onClick={() => setRefresh(value => value + 1)}>Refresh graph</button></header>
    <div className={css.summary} aria-label="Graph totals"><span><strong>{page?.counts.nodes ?? '…'}</strong> nodes</span>
      <span><strong>{page?.counts.edges ?? '…'}</strong> relationships</span><span><strong>{page?.counts.evidence ?? '…'}</strong> captures</span></div>
    <div className={css.targets}><strong>Configured targets</strong>{engagement.scope.targets.length
      ? engagement.scope.targets.map(target => <code key={target.host}>{target.host}</code>) : <span>No target rules configured</span>}</div>
    {error && <p role="alert" className={css.error}>{error}</p>}
    <div className={css.layout}>
      <aside className={css.browser} aria-label="Collected nodes">
        <label>Search nodes<input type="search" maxLength={300} placeholder="Host, endpoint or name" value={query} onChange={event => filter(() => setQuery(event.target.value))} /></label>
        <label>Node type<select value={type} onChange={event => filter(() => setType(event.target.value))}><option value="">All node types</option>
          {page?.types.map(item => <option key={item.name} value={item.name}>{item.name} ({item.count})</option>)}{type && !page?.types.some(item => item.name === type) && <option>{type}</option>}</select></label>
        <label>Collection<select value={collection} onChange={event => filter(() => setCollection(event.target.value))}><option value="">All collections</option>
          {page?.collections.map(item => <option key={item.name} value={item.name}>{item.name} · {item.count} captures</option>)}{collection && !page?.collections.some(item => item.name === collection) && <option>{collection}</option>}</select></label>
        <p className={css.hint}>Collections group evidence by the tool that captured it.</p>
        <p role="status">{busy ? 'Loading nodes…' : `${page?.total ?? 0} matching nodes`}</p>
        <div className={css.nodeList}>{page?.nodes.map(node => <button key={node.id} aria-label={`Inspect ${node.name}`} aria-pressed={selected === node.id} onClick={() => focus(node.id)}>
          <small>{node.type}</small><span>{node.name}</span></button>)}</div>
        {page && <nav className={css.paging} aria-label="Node pages"><button disabled={busy || offset === 0} onClick={() => setOffset(Math.max(0, offset - 100))}>Previous nodes</button>
          <span>{page.total ? offset + 1 : 0}–{offset + page.nodes.length} / {page.total}</span>
          <button disabled={busy || page.nextOffset === null} onClick={() => setOffset(page.nextOffset!)}>Next nodes</button></nav>}
      </aside>
      <div className={css.inspector}>
        {!page?.counts.nodes && !busy && <p className={css.empty}>No evidence collected yet. Run recon or a crawl to see targets, hosts and their relationships here.</p>}
        {page && page.counts.nodes > 0 && !page.nodes.length && !busy && <p className={css.empty}>No nodes match these filters.</p>}
        {detailBusy && <p role="status">Loading relationships…</p>}
        {detail && <>
          <header className={css.detailHeading}><small>{detail.node.type}</small><h3>{detail.node.name}</h3>
            <p>{detail.total} relationships · Observed {new Date(detail.node.observedAt).toLocaleString()}</p></header>
          <RelationshipMap detail={detail} focus={focus} />
          <h3>Relationships</h3>
          {!detail.total && <p className={css.hint}>No relationships have been recorded for this node.</p>}
          <div className={css.relationships}>{detail.edges.map(edge => {
            const outgoing = edge.source === detail.node.id, otherId = outgoing ? edge.target : edge.source;
            const other = otherId === detail.node.id ? detail.node : detail.nodes.find(node => node.id === otherId);
            return <button key={edge.id} onClick={() => focus(otherId)} aria-label={`Follow ${edge.type} to ${other?.name ?? otherId}`}>
              <span className={css.direction}>{outgoing ? '→' : '←'}</span><span><strong>{edge.type}</strong><small>{other?.type} · {other?.name ?? otherId}</small></span>
              <span className={css.status} data-status={edge.status}>{edge.status}</span></button>;
          })}</div>
          {detail.total > 30 && <nav className={css.paging} aria-label="Relationship pages"><button disabled={!detail.offset} onClick={() => setRelationOffset(Math.max(0, detail.offset - 30))}>Previous relationships</button>
            <span>{detail.offset + 1}–{detail.offset + detail.edges.length} / {detail.total}</span><button disabled={detail.nextOffset === null} onClick={() => setRelationOffset(detail.nextOffset!)}>Next relationships</button></nav>}
          <details className={css.attributes}><summary>Node attributes and identifier</summary><pre>{pretty({ id: detail.node.id, attributes: detail.node.attributes })}</pre></details>
          <h3>Supporting evidence</h3><p className={css.hint}>Captures supporting this node and the relationships on this page. {detail.evidence.length} of {detail.evidenceTotal} shown.</p>
          {!detail.evidence.length && <p className={css.hint}>No supporting capture recorded.</p>}
          {detail.evidence.map(evidence => <details key={evidence.id} className={css.capture}><summary>{evidence.tool} · {new Date(evidence.observedAt).toLocaleString()}</summary>
            <dl><dt>Media type</dt><dd>{evidence.mediaType}</dd><dt>Evidence ID</dt><dd>{evidence.id}</dd><dt>Content hash</dt><dd>{evidence.contentHash}</dd><dt>Stored at</dt><dd>{evidence.pointer}</dd></dl></details>)}
        </>}
      </div>
    </div>
  </section>;
}
