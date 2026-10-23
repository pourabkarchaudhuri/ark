import { CURRENT_POOL_VERSION, EMBEDDING_CHUNK_VERSION } from '@/services/embedding-chunks';

/**
 * Cache signature of the neighbour graph (and the PPR seeds derived from it). It used to be just the ANN vector
 * count, so a re-embed that kept the count (new chunk layout, new pooling) silently kept serving a graph built
 * from the OLD vectors. The embedding layout versions are part of it now.
 */
export function annGraphSignature(vectorCount: number): string {
  return `ann-${vectorCount}-c${EMBEDDING_CHUNK_VERSION}-p${CURRENT_POOL_VERSION}`;
}
