#!/usr/bin/env node
// Program: ashr - task.mjs
// Programmer: Ethan-da-Tech-Wizard (written with Claude, an AI assistant)
// Last Modified: 2026-11-18
// Purpose: Team git helper with three commands (task, sync, ship) that keeps two people and their coding agents on separate branches, and also blocks pushes to main.
// Team git helper. Keeps two people and their coding agents out of each other's way.
//   npm run task -- zazu/pitch     new branch from the latest main, in its own folder
//   npm run sync                   pull in the latest main, run the tests, warn about overlap
//   npm run ship                   sync, then push and print the pull request link
// Node helpers for running git (without a shell), checking files and handling paths.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';

// Run a git command and return its trimmed output.
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
// Split text into non-empty lines.
const lines = (text) => text.split('\n').filter(Boolean);
// Print a normal message with the ashr prefix.
const say = (msg) => console.log(`ashr: ${msg}`);
// Print an error message with the ashr prefix and exit with code 1.
const stop = (msg) => { console.error(`ashr: ${msg}`); process.exit(1); };
// Allowed branch names: zazu/<thing> or ethan/<thing>, lower case with dashes.
const BRANCH = /^(zazu|ethan)\/[a-z0-9][a-z0-9-]*$/;

// Make sure git uses the .githooks folder (which holds the pre-push check).
function installHooks() {
  if (git('config', '--default', '', '--get', 'core.hooksPath') !== '.githooks') git('config', 'core.hooksPath', '.githooks');
}

// Start a new branch from the latest main: either switch to it here (--here, only if there are no unsaved changes) or create it in its own folder next to the repo using git worktree.
function task(name, here) {
  if (!BRANCH.test(name || '')) stop('name the branch zazu/<thing> or ethan/<thing>, for example: npm run task -- zazu/pitch');
  git('fetch', '--quiet', 'origin');
  if (git('branch', '--all', '--list', name, `origin/${name}`)) stop(`branch ${name} already exists. Pick another name or continue it there.`);
  if (here) {
    if (git('status', '--porcelain')) stop('you have unsaved changes here. Commit them, or run without --here to get a separate folder.');
    git('switch', '--quiet', '--create', name, 'origin/main');
    return say(`on ${name}, started from the latest main.`);
  }
  const root = git('rev-parse', '--show-toplevel');
  const dir = join(dirname(root), `${basename(root)}-${name.split('/')[1]}`);
  if (existsSync(dir)) stop(`folder ${dir} already exists.`);
  git('worktree', 'add', '--quiet', '-b', name, dir, 'origin/main');
  say(`${name} is ready in its own folder, started from the latest main:`);
  console.log(`  cd "${dir}"`);
}

// Find files that this branch changes and another unmerged remote branch also changes, so people can talk before merging.
// Files this branch changes that another unmerged branch also changes.
// Compare this branch's changed files with each other unmerged branch.
function overlaps(branch) {
  const mine = new Set(lines(git('diff', '--name-only', 'origin/main...HEAD')));
  if (!mine.size) return [];
  const others = lines(git('branch', '--remotes', '--no-merged', 'origin/main', '--format=%(refname:short)'))
    .filter((ref) => ref !== `origin/${branch}` && ref !== 'origin/HEAD' && ref !== 'origin');
  return others
    .map((ref) => ({ branch: ref.replace('origin/', ''), files: lines(git('diff', '--name-only', `origin/main...${ref}`)).filter((f) => mine.has(f)) }))
    .filter((o) => o.files.length);
}

// Bring the current branch up to date: fetch, merge origin/main, run the tests, and warn about overlapping branches. On main it only fast-forwards. Returns the branch name, or null on main.
function sync() {
  const branch = git('branch', '--show-current');
  if (git('status', '--porcelain')) stop('commit your changes first, then sync.');
  git('fetch', '--quiet', '--prune', 'origin');
  if (branch === 'main') {
    git('merge', '--quiet', '--ff-only', 'origin/main');
    say('main is up to date. Start work with: npm run task -- <you>/<thing>');
    return null;
  }
  try {
    execFileSync('git', ['merge', '--no-edit', '--quiet', 'origin/main'], { stdio: 'inherit' });
  } catch {
    stop('main changed the same lines you did. Fix the files marked above, commit, then run npm run sync again.');
  }
  try {
    execFileSync(process.execPath, ['--test', '--test-reporter=dot'], { stdio: ['ignore', 'ignore', 'inherit'] });
  } catch {
    stop('tests fail after pulling in main. Run npm test, fix them, then sync again.');
  }
  say(`${branch} has the latest main and the tests pass.`);
  for (const o of overlaps(branch)) say(`heads up: ${o.branch} also edits ${o.files.join(', ')}. Talk before you both merge.`);
  return branch;
}

// Sync, push the branch and print the link for opening a pull request.
function ship() {
  const branch = sync();
  if (!branch) return;
  git('push', '--quiet', '--set-upstream', 'origin', branch);
  const url = git('remote', 'get-url', 'origin').replace(/\.git$/, '').replace(/^git@github\.com:/, 'https://github.com/');
  say('pushed. Open the pull request here:');
  console.log(`  ${url}/compare/main...${branch}?expand=1`);
}

// Pre-push check: refuse a push whose target is refs/heads/main.
// Called by .githooks/pre-push. Git sends "<local ref> <local sha> <remote ref> <remote sha>" lines.
// Each input line is "<local ref> <local sha> <remote ref> <remote sha>"; the third field is the remote branch.
function prepush(pushed) {
  if (pushed.some((l) => l.split(' ')[2] === 'refs/heads/main')) {
    stop('pushing straight to main is blocked. Push your branch and open a pull request.');
  }
}

// The first argument chooses the command: prepush reads the pushed refs from stdin; task, sync and ship do their work; anything else prints usage.
const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'prepush') {
  let input = '';
  process.stdin.on('data', (d) => { input += d; }).on('end', () => prepush(lines(input)));
} else {
  installHooks();
  if (cmd === 'task') task(rest.find((a) => !a.startsWith('--')), rest.includes('--here'));
  else if (cmd === 'sync') sync();
  else if (cmd === 'ship') ship();
  else stop('use: npm run task -- <you>/<thing> | npm run sync | npm run ship');
}
