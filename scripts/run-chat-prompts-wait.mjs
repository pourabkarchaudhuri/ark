#!/usr/bin/env node
/**
 * Run chat prompt tests and wait for completion (or timeout).
 * Usage: node scripts/run-chat-prompts-wait.mjs
 * Requires .env with AZURE_OPENAI_* (or run from project root after setting env).
 * Spawns: npm run test:chat-prompts
 * Waits for tests/chat-prompts-results.json to have 50 results, or 30 min max.
 */
import { spawn } from 'child_process';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const resultsPath = join(process.cwd(), 'tests', 'chat-prompts-results.json');
const maxWaitMs = 30 * 60 * 1000;
const pollMs = 5000;

const child = spawn('npm', ['run', 'test:chat-prompts'], {
  cwd: process.cwd(),
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: true,
});

child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (d) => process.stdout.write(d));
child.stderr.on('data', (d) => process.stderr.write(d));

const start = Date.now();
function check() {
  if (Date.now() - start > maxWaitMs) {
    console.error('Timeout waiting for 50 results.');
    child.kill('SIGTERM');
    process.exit(1);
  }
  if (!existsSync(resultsPath)) {
    setTimeout(check, pollMs);
    return;
  }
  try {
    const data = JSON.parse(readFileSync(resultsPath, 'utf8'));
    const n = data.results?.length ?? 0;
    if (n >= 50) {
      console.log(`Done. ${n} results in ${resultsPath}`);
      child.kill('SIGTERM');
      process.exit(0);
    }
  } catch (_) {}
  setTimeout(check, pollMs);
}

child.on('exit', (code, signal) => {
  if (existsSync(resultsPath)) {
    try {
      const data = JSON.parse(readFileSync(resultsPath, 'utf8'));
      const n = data.results?.length ?? 0;
      console.log(`Process exited. ${n} results in ${resultsPath}`);
    } catch (_) {}
  }
  process.exit(code ?? (signal ? 1 : 0));
});

setTimeout(check, 10000); // start checking after 10s
