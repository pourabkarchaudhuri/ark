#!/usr/bin/env node
/**
 * Run all 50 chat prompts by launching Electron once per prompt (avoids long-running
 * single process that may be killed). Aggregates results into tests/chat-prompts-results.json.
 *
 * Usage: node scripts/run-chat-prompts-all.mjs
 * Requires: .env with AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_KEY, AZURE_OPENAI_DEPLOYMENT
 */
import { spawn } from 'child_process';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';

const testsDir = join(process.cwd(), 'tests');
const resultsPath = join(testsDir, 'chat-prompts-results.json');
const PER_PROMPT_TIMEOUT_MS = 90_000; // 90s per prompt

function runOne(index) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.platform === 'win32' ? 'npx.cmd' : 'npx',
      ['electron', '.', '--run-chat-prompts'],
      {
        cwd: process.cwd(),
        env: { ...process.env, CHAT_PROMPT_INDEX: String(index) },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Prompt ${index} timed out after ${PER_PROMPT_TIMEOUT_MS / 1000}s`));
    }, PER_PROMPT_TIMEOUT_MS);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && !signal) resolve();
      else reject(new Error(`Exit ${code} ${signal}`));
    });
  });
}

async function main() {
  const promptCount = 50;
  const results = [];
  for (let i = 0; i < promptCount; i++) {
    const file = join(testsDir, `chat-prompts-results-${i}.json`);
    if (existsSync(file)) try { unlinkSync(file); } catch (_) {}
    process.stdout.write(`[${i + 1}/${promptCount}] Running prompt ${i}... `);
    try {
      await runOne(i);
      if (existsSync(file)) {
        const data = JSON.parse(readFileSync(file, 'utf8'));
        const r = data.results?.[0];
        if (r) {
          results.push(r);
          console.log(`id=${r.id} tools=${(r.toolsUsed || []).join(',') || 'none'}`);
        } else {
          results.push({ id: i + 1, category: '', prompt: '', content: '', toolsUsed: [], error: 'No result in file' });
          console.log('no result');
        }
        try { unlinkSync(file); } catch (_) {}
      } else {
        results.push({ id: i + 1, category: '', prompt: '', content: '', toolsUsed: [], error: 'Results file not written' });
        console.log('no file');
      }
    } catch (err) {
      results.push({
        id: i + 1,
        category: '',
        prompt: '',
        content: '',
        toolsUsed: [],
        error: err?.message || String(err),
      });
      console.log('ERROR:', err?.message || err);
    }
  }
  writeFileSync(
    resultsPath,
    JSON.stringify(
      { description: 'Chat prompt test results (aggregated)', ranAt: new Date().toISOString(), results },
      null,
      2
    ),
    'utf8'
  );
  console.log(`\nWrote ${results.length} results to ${resultsPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
