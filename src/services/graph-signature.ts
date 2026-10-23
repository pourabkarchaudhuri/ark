import { CURRENT_POOL_VERSION, EMBEDDING_CHUNK_VERSION } from '@/services/embedding-chunks';
import { layoutKeySuffix } from '@/services/embedding-layout';

/**
 * Cache signature of the neighbour graph (and the PPR seeds derived from it). It used to be just the ANN vector
 * count, so a re-embed that kept the count (new chunk layout, new pooling) silently kept serving a graph built
 * from the OLD vectors. The embedding layout versions are part of it now.
 */
export function annGraphSignature(vectorCount: number): string {
  // layoutKeySuffix() is '' for layout generation 1 (existing signatures stay valid) and `-g<N>` afterwards.
  return `ann-${vectorCount}-c${EMBEDDING_CHUNK_VERSION}-p${CURRENT_POOL_VERSION}${layoutKeySuffix()}`;
}
