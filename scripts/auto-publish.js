#!/usr/bin/env node
// Stop hook: commits whatever the turn changed, pushes main, and tells Efrain
// what happened in one line (the `systemMessage` Claude Code shows after a turn).
// Says nothing when the turn changed no files.
const { execSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const run = (cmd) => execSync(cmd, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const say = (text) => process.stdout.write(JSON.stringify({ systemMessage: text }));

try {
  if (!run('git status --porcelain')) process.exit(0);

  run('git add -A');
  const files = run('git diff --cached --name-only').split('\n').filter(Boolean).length;
  let msg = 'update codebase';
  try { msg = run('node scripts/commit-msg.js') || msg; } catch (e) {}
  execSync('git commit -F -', { cwd: root, input: msg, stdio: ['pipe', 'ignore', 'ignore'] });

  const hash = run('git rev-parse --short HEAD');
  const branch = run('git rev-parse --abbrev-ref HEAD');
  const what = `"${msg}" (${files} file${files === 1 ? '' : 's'}, ${hash})`;

  if (branch !== 'main') {
    say(`Saved on branch ${branch}, not published: ${what}. efrain.fm is unchanged.`);
    process.exit(0);
  }
  try {
    run('git push origin main');
    say(`Published to efrain.fm: ${what}. Live in about a minute.`);
  } catch (e) {
    say(`NOT published: ${what} was saved on this computer but the push failed, so efrain.fm is unchanged.`);
  }
} catch (e) {
  say(`Auto-publish failed before saving anything: ${String(e.message || e).split('\n')[0]}`);
}
