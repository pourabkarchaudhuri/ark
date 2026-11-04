/**
 * Heap snapshot diff for leak triage: constructor-level growth between two snapshots of the same renderer,
 * plus a retainer path (shortest path from the GC root) for one object that did not exist in the first snapshot.
 */
import fs from 'node:fs';

export async function takeSnapshot(cdp, file) {
  const chunks = [];
  const on = (p) => chunks.push(p.chunk);
  cdp.on('HeapProfiler.addHeapSnapshotChunk', on);
  await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
  cdp.off('HeapProfiler.addHeapSnapshotChunk', on);
  fs.writeFileSync(file, chunks.join(''));
  return file;
}

function load(file) {
  const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
  const meta = snap.snapshot.meta;
  const nf = meta.node_fields.length;
  const ef = meta.edge_fields.length;
  const nodeTypes = meta.node_types[0];
  const edgeTypes = meta.edge_types[0];
  return { snap, nf, ef, nodeTypes, edgeTypes, strings: snap.strings, nodes: snap.nodes, edges: snap.edges, meta };
}

export function diffSnapshots(fileA, fileB, { top = 8 } = {}) {
  const A = load(fileA);
  const B = load(fileB);
  const f = (S, name) => S.meta.node_fields.indexOf(name);
  const group = (S) => {
    const t = f(S, 'type');
    const n = f(S, 'name');
    const sz = f(S, 'self_size');
    const m = new Map();
    for (let i = 0; i < S.nodes.length; i += S.nf) {
      const type = S.nodeTypes[S.nodes[i + t]];
      if (type === 'hidden' || type === 'array' || type === 'synthetic' || type === 'code') continue;
      const key = `${type}:${S.strings[S.nodes[i + n]]}`.slice(0, 120);
      const e = m.get(key) ?? { count: 0, size: 0 };
      e.count++;
      e.size += S.nodes[i + sz];
      m.set(key, e);
    }
    return m;
  };
  const ga = group(A);
  const gb = group(B);
  const growth = [];
  for (const [k, v] of gb) {
    const a = ga.get(k) ?? { count: 0, size: 0 };
    if (v.count - a.count > 0) growth.push({ key: k, dCount: v.count - a.count, dKB: Math.round((v.size - a.size) / 1024), before: a.count, after: v.count });
  }
  growth.sort((x, y) => y.dKB - x.dKB || y.dCount - x.dCount);

  // ids present in A
  const idA = f(A, 'id');
  const idsA = new Set();
  for (let i = 0; i < A.nodes.length; i += A.nf) idsA.add(A.nodes[i + idA]);

  // BFS from the root in B (skip weak edges)
  const nB = B.nodes.length / B.nf;
  const firstEdge = new Int32Array(nB + 1);
  const ecIdx = f(B, 'edge_count');
  let e = 0;
  for (let n = 0; n < nB; n++) {
    firstEdge[n] = e;
    e += B.nodes[n * B.nf + ecIdx];
  }
  firstEdge[nB] = e;
  const et = B.meta.edge_fields.indexOf('type');
  const en = B.meta.edge_fields.indexOf('name_or_index');
  const eto = B.meta.edge_fields.indexOf('to_node');
  const parent = new Int32Array(nB).fill(-2);
  const parentEdge = new Int32Array(nB).fill(-1);
  parent[0] = -1;
  const q = [0];
  for (let h = 0; h < q.length; h++) {
    const n = q[h];
    for (let k = firstEdge[n]; k < firstEdge[n + 1]; k++) {
      const type = B.edgeTypes[B.edges[k * B.ef + et]];
      if (type === 'weak') continue;
      const to = B.edges[k * B.ef + eto] / B.nf;
      if (parent[to] !== -2) continue;
      parent[to] = n;
      parentEdge[to] = k;
      q.push(to);
    }
  }
  const nameOf = (n) => `${B.nodeTypes[B.nodes[n * B.nf + f(B, 'type')]]}:${String(B.strings[B.nodes[n * B.nf + f(B, 'name')]]).slice(0, 60)}`;
  const pathTo = (n) => {
    const out = [];
    for (let cur = n, guard = 0; cur > 0 && parent[cur] >= 0 && guard < 40; cur = parent[cur], guard++) {
      const k = parentEdge[cur];
      const type = B.edgeTypes[B.edges[k * B.ef + et]];
      const raw = B.edges[k * B.ef + en];
      const label = type === 'element' || type === 'hidden' ? `[${raw}]` : B.strings[raw];
      out.push(`${nameOf(parent[cur])} --${type}:${label}--> ${nameOf(cur)}`);
    }
    return out.reverse();
  };

  const idB = f(B, 'id');
  const nameIdx = f(B, 'name');
  const typeIdx = f(B, 'type');
  const lines = ['Top growth by constructor (count and KB):'];
  for (const g of growth.slice(0, top)) {
    lines.push(`  ${g.key}: ${g.before} -> ${g.after} (+${g.dCount}, ${g.dKB >= 0 ? '+' : ''}${g.dKB} KB)`);
  }
  lines.push('', 'Retainer paths (shortest from GC root) for one new object of each top grower:');
  for (const g of growth.slice(0, Math.min(top, 5))) {
    let sample = -1;
    for (let n = 0; n < nB; n++) {
      const key = `${B.nodeTypes[B.nodes[n * B.nf + typeIdx]]}:${B.strings[B.nodes[n * B.nf + nameIdx]]}`.slice(0, 120);
      if (key === g.key && !idsA.has(B.nodes[n * B.nf + idB]) && parent[n] >= 0) {
        sample = n;
        break;
      }
    }
    lines.push(`  ${g.key}:`);
    if (sample < 0) lines.push('    (no unreachable-from-A sample found)');
    else for (const p of pathTo(sample).slice(-12)) lines.push(`    ${p}`);
  }
  return lines.join('\n');
}
