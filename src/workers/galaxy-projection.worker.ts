/**
 * Galaxy Projection Worker
 *
 * Random-projects pages of int8 pooled vectors (1024D → 100D) off the
 * renderer main thread. The galaxy precompute used to run a 100×1024
 * projection per vector inline — ~160 back-to-back 100-200 ms tasks.
 *
 * Protocol: one `init` with the projection matrix, then `page` messages
 * (transferable Int8Array rows + scales); each page is answered in order.
 */

import {
  projectInt8Page,
  type GalaxyProjectionWorkerInput,
  type GalaxyProjectionWorkerOutput,
} from '../services/galaxy-projection';

let R: Float32Array | null = null;
let srcDim = 0;
let projDim = 0;

self.onmessage = (e: MessageEvent<GalaxyProjectionWorkerInput>) => {
  const msg = e.data;
  if (msg.type === 'init') {
    R = msg.R;
    srcDim = msg.srcDim;
    projDim = msg.projDim;
    return;
  }
  if (msg.type !== 'page') return;
  try {
    if (!R) throw new Error('projection worker not initialised');
    const out = projectInt8Page(msg.q, msg.scales, msg.count, R, srcDim, projDim);
    const reply: GalaxyProjectionWorkerOutput = { type: 'page', id: msg.id, out };
    (self as unknown as Worker).postMessage(reply, [out.buffer as ArrayBuffer]);
  } catch (err) {
    const reply: GalaxyProjectionWorkerOutput = {
      type: 'error',
      id: msg.id,
      error: err instanceof Error ? err.message : String(err),
    };
    (self as unknown as Worker).postMessage(reply);
  }
};

export {};
