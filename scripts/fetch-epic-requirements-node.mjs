#!/usr/bin/env node
/**
 * Standalone Node script: fetch Epic CMS product content (system requirements)
 * with TLS verification disabled. No Electron. Run: NODE_TLS_REJECT_UNAUTHORIZED=0 node scripts/fetch-epic-requirements-node.mjs [slug]
 */
import https from 'node:https';

const slug = process.argv[2] || 'death-stranding-2-on-the-beach-7773ec';
const url = `https://store-content.ak.epicgames.com/api/en-US/content/products/${slug}`;

function fetch() {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        rejectUnauthorized: false,
        headers: { Accept: 'application/json' },
      },
      (res) => {
        let body = '';
        res.on('data', (ch) => { body += ch; });
        res.on('end', () => {
          try {
            const json = JSON.parse(body);
            resolve({ status: res.statusCode, json });
          } catch (e) {
            resolve({ status: res.statusCode, json: null, parseError: e.message });
          }
        });
      }
    );
    req.on('error', (e) => reject(e));
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error('timeout 15s'));
    });
  });
}

fetch()
  .then(({ status, json }) => {
    console.log('\n=== Epic CMS response (bypass TLS) ===');
    console.log('Slug:', slug);
    console.log('Status:', status);
    if (!json) {
      console.log('No JSON body\n');
      return;
    }
    const pages = json.pages || [];
    let requirements = null;
    for (const page of pages) {
      const data = page?.data;
      if (data?.requirements?.systems) {
        requirements = data.requirements.systems;
        break;
      }
    }
    if (requirements?.length) {
      console.log('\nSystem requirements:\n');
      for (const sys of requirements) {
        console.log('Platform:', sys.systemType || 'unknown');
        for (const d of sys.details || []) {
          const title = d.title || 'Spec';
          const min = typeof d.minimum === 'object' ? Object.entries(d.minimum).map(([k, v]) => `${k}: ${v}`).join(', ') : String(d.minimum ?? '—');
          const rec = typeof d.recommended === 'object' ? Object.entries(d.recommended).map(([k, v]) => `${k}: ${v}`).join(', ') : String(d.recommended ?? '—');
          console.log(`  ${title} — Min: ${min} | Rec: ${rec}`);
        }
        console.log('');
      }
      console.log('=== End ===\n');
    } else {
      console.log('No requirements in response. Pages:', pages.length);
    }
  })
  .catch((e) => {
    console.error('Error:', e.message);
    process.exit(1);
  });
