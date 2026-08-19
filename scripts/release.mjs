#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

/**
 * Cut a release: bump the version, fold the working tree into a `release:`
 * commit, tag it, and push.
 *
 * Why this exists:
 *   The version lives in exactly two files (`package.json` + its lockfile), but
 *   the *convention* around it is not something npm can express: every release
 *   here folds the feature work into the release commit itself (`release: v0.6.0
 *   — …`) and carries an annotated tag. `npm version` refuses a dirty tree and
 *   insists on making its own bump-only commit, so the flow was four hand-typed
 *   commands with a version number repeated in three of them — exactly the shape
 *   of thing that eventually ships a tag pointing at the wrong tree.
 *
 * What it does:
 *   1. Prints the current release state (version, tag-on-HEAD, branch, sync,
 *      what would be staged) — always, before touching anything — then asks
 *      to confirm the bump (Enter accepts).
 *   2. Preflight: right branch, not behind origin, tag not already taken, then
 *      `npm run check && npm run lint && npm run test`. All read-only; a failure
 *      here leaves the tree exactly as it found it.
 *   3. `npm version <target> --no-git-tag-version` (package.json + lockfile).
 *   4. `git add -A` + commit as `release: vX.Y.Z — <subject>`.
 *   5. Annotated tag `vX.Y.Z`.
 *   6. Confirm, then `git push --follow-tags`.
 *
 * Usage:
 *   npm run release -- minor -m "compression phase 3 — the sweep"
 *   npm run release -- minor -m "…" --body-file notes.md
 *   npm run release -- 0.7.0 -m "…"
 *   npm run release -- minor --dry-run
 *   npm run release -- --help
 *
 * Concerns / future improvements:
 *   - Nothing stamps the version into the CLI, so `media-manager --version` does
 *     not exist; if it ever does, it should read package.json rather than add a
 *     third place for this script to keep in sync.
 *   - No changelog generation: `docs/FEATURES.md` and `docs/FUTURE_CHANGES.md`
 *     stay hand-maintained (CLAUDE.md mandates updating them in the same change
 *     as the behavior, which is earlier than release time).
 *   - Does not publish to npm. `prepublishOnly` stays a deliberate manual step.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const pkgPath = path.join(repoRoot, 'package.json');
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const TAG = '[release]';

/** Read early: the --help examples are rendered against the actual current version. */
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const current = pkg.version;
const [curMaj, curMin, curPat] = current.split('.').map(Number);

const HELP = `
Cut a release: bump the version, fold the working tree into a "release:" commit,
tag it, and push.

Usage:
  npm run release -- <patch|minor|major|X.Y.Z> [options]

Which one? (media-manager is pre-1.0 — see the note at the end)

  patch   ${current} -> ${curMaj}.${curMin}.${curPat + 1}   Nothing new to learn, nothing to migrate.
          Bug fixes, performance, copy, styling, dependency bumps. Someone on
          ${current} upgrades without reading anything and nothing they built stops
          working. The google-photos poll fix was a patch-shaped change.

  minor   ${current} -> ${curMaj}.${curMin + 1}.0   New capability, existing usage keeps working.
          A new feature, route, API endpoint, field type, or CLI verb; a new
          optional argument. Every release through v0.6.0 was a minor:
          static-assets mode, the compression ladder, the reader srcset.
          Additive changes to a data root that older versions still read are
          minor too.

  major   ${current} -> ${curMaj + 1}.0.0   Something that worked before now needs a change.
          Reach for this when you break one of the three surfaces other people
          actually depend on:
            - the reader package (media-manager/reader) — a removed or renamed
              export, a changed function signature or return shape. nicb.at
              consumes this; a major says "your build will fail until you edit".
            - the CLI (bin/media-manager.js) — a removed verb or flag, or a
              changed default that silently does something else.
            - the on-disk data root — any layout change that makes an existing
              workspace unreadable until "npm run upgrade-data -- <root> --apply"
              is run. The Item 18 records reorg was this shape.

  Pre-1.0 caveat: at 0.x, semver formally lets a minor break things, and this
  project has used that latitude — the file-first redesign landed in a minor.
  The rubric above is the convention regardless. Save the 1.0.0 bump for the
  moment you mean to *promise* the reader API and the data layout are stable,
  not merely the next time something breaks.

  Not sure? Ask what a consumer has to DO. Nothing -> patch. Optionally adopt
  something new -> minor. Edit their code, their command, or their data root
  before it works again -> major.

Options:
  -m, --message <subject>   Commit subject, used after "release: vX.Y.Z — ".
                            Omit it and $EDITOR opens with a template.
      --body-file <path>    File holding the long commit body.
      --dry-run             Print every step and the exact commit and tag,
                            change nothing.
      --no-push             Stop after the local tag (also lifts the
                            must-be-on-main check).
      --skip-checks         Skip check + lint + test.
  -y, --yes                 Do not prompt at all (neither the version
                            confirm nor the push confirm).
  -h, --help                This text.

Notes:
  - The release commit includes ALL working-tree changes, tracked and untracked
    (git add -A), matching how v0.4.0 - v0.6.0 were made. New files are usually
    the point of the release, so leaving them out is the worse failure. The
    "staging" line printed in step 1 is where you catch a stray file.
  - Everything before the bump is read-only. If a later step fails, the exact
    rollback commands are printed.
`;

/** Run a command, inheriting stdio; returns the exit status. */
function run(cmd, args, opts = {}) {
	return spawnSync(cmd, args, { cwd: repoRoot, stdio: 'inherit', ...opts }).status ?? 1;
}

/** Run git and capture trimmed stdout ('' on failure). */
function git(...args) {
	const r = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
	return (r.stdout ?? '').trim();
}

/** Run git for effect; abort the process (with a rollback hint) on failure. */
function gitOrDie(args, hint) {
	if (run('git', args) !== 0) fail(`git ${args.join(' ')} failed.`, hint);
}

function fail(message, hint) {
	console.error(`\n${TAG} ${message}`);
	if (hint) console.error(hint);
	process.exit(1);
}

/** Parse "1.2.3" into [1,2,3]; null if it is not a plain release version. */
function parseVersion(v) {
	const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
	return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * Resolve a bump keyword or explicit version against the current version.
 * Kept local (rather than shelling out to npm) so --dry-run can report the
 * next version without mutating package.json.
 */
function nextVersion(current, target) {
	const [maj, min, pat] = parseVersion(current) ?? fail(`Unreadable version "${current}".`);
	if (target === 'major') return `${maj + 1}.0.0`;
	if (target === 'minor') return `${maj}.${min + 1}.0`;
	if (target === 'patch') return `${maj}.${min}.${pat + 1}`;
	const explicit = parseVersion(target);
	if (!explicit) fail(`"${target}" is not patch, minor, major, or an X.Y.Z version.`);
	const [a, b, c] = explicit;
	const ordered = a > maj || (a === maj && (b > min || (b === min && c > pat)));
	if (!ordered) fail(`Version ${target} is not greater than the current ${current}.`);
	return target;
}

/** Collect the commit message body in $EDITOR, git-commit style. */
function editBody(subject, version) {
	const editor = process.env.GIT_EDITOR || process.env.VISUAL || process.env.EDITOR || 'vi';
	const file = path.join(os.tmpdir(), `media-manager-release-${process.pid}.txt`);
	fs.writeFileSync(
		file,
		`release: v${version} — ${subject ?? ''}\n\n\n` +
			`# Write the release commit message above. The first line is the subject.\n` +
			`# Lines starting with '#' are ignored. An empty message aborts the release.\n`
	);
	const status = spawnSync(editor, [file], { stdio: 'inherit', shell: true }).status;
	const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
	fs.rmSync(file, { force: true });
	if (status !== 0) fail('Editor exited non-zero; nothing has been changed.');
	const text = raw
		.split('\n')
		.filter((line) => !line.startsWith('#'))
		.join('\n')
		.trim();
	if (!text) fail('Empty commit message; nothing has been changed.');
	return text;
}

/**
 * Ask a yes/no question on the terminal.
 *
 * @param question  Prompt text, without the bracketed hint.
 * @param defaultYes  When true the prompt reads [Y/n] and a bare Enter means
 *   yes — used for the "is this the bump you meant?" gate, where the answer is
 *   almost always yes and the prompt exists only to catch a typo'd keyword. The
 *   push gate keeps the opposite default, because that one leaves the repo.
 */
async function confirm(question, { defaultYes = false } = {}) {
	if (!process.stdin.isTTY) {
		fail('Not a TTY, so the release cannot be confirmed interactively.', 'Re-run with --yes.');
	}
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	const hint = defaultYes ? '[Y/n]' : '[y/N]';
	const answer = await new Promise((resolve) => rl.question(`${question} ${hint} `, resolve));
	rl.close();
	const reply = answer.trim();
	if (!reply) return defaultYes;
	return /^y(es)?$/i.test(reply);
}

// ---------------------------------------------------------------- arguments

const argv = process.argv.slice(2);
if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) {
	console.log(HELP);
	process.exit(argv.length === 0 ? 1 : 0);
}

let target = null;
let subject = null;
let bodyFile = null;
let dryRun = false;
let push = true;
let skipChecks = false;
let assumeYes = false;

for (let i = 0; i < argv.length; i++) {
	const arg = argv[i];
	if (arg === '-m' || arg === '--message') subject = argv[++i];
	else if (arg === '--body-file') bodyFile = argv[++i];
	else if (arg === '--dry-run') dryRun = true;
	else if (arg === '--no-push') push = false;
	else if (arg === '--skip-checks') skipChecks = true;
	else if (arg === '-y' || arg === '--yes') assumeYes = true;
	else if (arg.startsWith('-')) fail(`Unknown option "${arg}".`, 'Run with --help.');
	else if (target === null) target = arg;
	else fail(`Unexpected argument "${arg}".`, 'Run with --help.');
}

if (!target) fail('Missing the bump: patch, minor, major, or an explicit X.Y.Z.', HELP);
if (subject !== undefined && subject !== null && !subject.trim())
	fail('-m was given an empty subject.');
if (bodyFile && !fs.existsSync(bodyFile)) fail(`--body-file "${bodyFile}" does not exist.`);

// --------------------------------------------------------- 1. state report

if (!fs.existsSync(path.join(repoRoot, '.git'))) fail('Not a git repository.');

const version = nextVersion(current, target);
const tagName = `v${version}`;

const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
const tagsAtHead = git('tag', '--points-at', 'HEAD').split('\n').filter(Boolean);
const dirty = git('status', '--porcelain').split('\n').filter(Boolean);

console.log(
	`\n${TAG} current   v${current}${tagsAtHead.length ? `  (tagged ${tagsAtHead.join(', ')} at HEAD)` : ''}`
);
console.log(`${TAG} next      ${tagName}`);
console.log(`${TAG} branch    ${branch}`);
console.log(
	`${TAG} staging   ${
		dirty.length
			? `${dirty.length} working-tree change(s) will be folded into the release commit`
			: 'clean tree — the release commit will carry the version bump only'
	}`
);
for (const line of dirty) console.log(`             ${line}`);

// The cheapest possible catch for a typo'd bump keyword: ask before spending a
// test run, and long before anything is written. Enter accepts.
if (!dryRun && !assumeYes) {
	const proceed = await confirm(`\n${TAG} release v${current} as ${tagName}?`, {
		defaultYes: true
	});
	if (!proceed) {
		console.log(`${TAG} aborted — nothing has been changed.`);
		process.exit(0);
	}
}

// ------------------------------------------------------------ 2. preflight

if (git('rev-parse', '-q', '--verify', `refs/tags/${tagName}`)) {
	fail(`Tag ${tagName} already exists.`, 'Pick a different version, or delete the tag first.');
}

if (push) {
	if (branch !== 'main') {
		fail(
			`On branch "${branch}", but releases are cut from main.`,
			'Use --no-push to tag locally anyway.'
		);
	}
	console.log(`\n${TAG} fetching origin…`);
	if (run('git', ['fetch', 'origin', '--quiet']) !== 0) fail('git fetch failed.');
	const upstream = git('rev-parse', '-q', '--verify', `origin/${branch}`);
	if (upstream) {
		const behind = Number(git('rev-list', '--count', `HEAD..origin/${branch}`) || '0');
		if (behind > 0) {
			fail(
				`origin/${branch} is ${behind} commit(s) ahead of you.`,
				'Pull and re-run — otherwise the tag would point at a stale tree.'
			);
		}
	}
}

// The message is resolved before anything is written, so an aborted editor or a
// missing body costs nothing.
let message;
if (dryRun && !subject) {
	message = `release: ${tagName} — <subject collected from $EDITOR>`;
} else if (subject) {
	const body = bodyFile ? fs.readFileSync(bodyFile, 'utf8').trim() : '';
	message = `release: ${tagName} — ${subject.trim()}${body ? `\n\n${body}` : ''}`;
} else {
	message = editBody(subject, version);
}
const messageSubject = message.split('\n')[0];

if (!skipChecks) {
	if (dryRun) {
		console.log(`\n${TAG} would run: npm run check && npm run lint && npm run test`);
	} else {
		for (const script of ['check', 'lint', 'test']) {
			console.log(`\n${TAG} npm run ${script}`);
			if (run(npmCmd, ['run', script]) !== 0) {
				fail(
					`"npm run ${script}" failed — nothing has been changed.`,
					'Fix it, or re-run with --skip-checks.'
				);
			}
		}
	}
} else {
	console.log(`\n${TAG} --skip-checks: not running check/lint/test.`);
}

// ------------------------------------------------- 3-5. bump, commit, tag

const plan = [
	`npm version ${version} --no-git-tag-version`,
	'git add -A',
	`git commit -F .git/RELEASE_COMMITMSG   (subject: ${JSON.stringify(messageSubject)}${message.includes('\n') ? ', + body' : ''})`,
	`git tag -a ${tagName} -m ${JSON.stringify(`${tagName} — ${messageSubject.replace(/^release: v[\d.]+ — /, '')}`)}`,
	push ? `git push --follow-tags origin ${branch}` : '(no push)'
];

if (dryRun) {
	console.log(`\n${TAG} dry run — would run:`);
	for (const step of plan) console.log(`             ${step}`);
	console.log(`\n${TAG} commit message:\n`);
	console.log(
		message
			.split('\n')
			.map((l) => `             ${l}`)
			.join('\n')
	);
	process.exit(0);
}

const rollback = `${TAG} to undo: git reset --hard HEAD~1 && git tag -d ${tagName}`;

console.log(`\n${TAG} bumping to ${version}…`);
if (run(npmCmd, ['version', version, '--no-git-tag-version']) !== 0) {
	fail('npm version failed — nothing has been committed.');
}

const msgFile = path.join(repoRoot, '.git', 'RELEASE_COMMITMSG');
fs.writeFileSync(msgFile, `${message}\n`);
gitOrDie(
	['add', '-A'],
	`${TAG} the version bump is staged but uncommitted; "git checkout -- package.json package-lock.json" to undo.`
);
gitOrDie(['commit', '-F', msgFile], `${TAG} the version bump is staged but uncommitted.`);
fs.rmSync(msgFile, { force: true });

const tagMessage = `${tagName} — ${messageSubject.replace(/^release: v[\d.]+ — /, '')}`;
gitOrDie(
	['tag', '-a', tagName, '-m', tagMessage],
	`${TAG} the release commit exists but is untagged: git reset --hard HEAD~1`
);

console.log(`\n${TAG} committed and tagged ${tagName}.`);

// ---------------------------------------------------------------- 6. push

if (!push) {
	console.log(`${TAG} --no-push: stopping here. To push: git push --follow-tags origin ${branch}`);
	process.exit(0);
}

const ok = assumeYes || (await confirm(`${TAG} push ${tagName} to origin/${branch}?`));
if (!ok) {
	console.log(`${TAG} not pushed. When ready: git push --follow-tags origin ${branch}`);
	console.log(rollback);
	process.exit(0);
}

if (run('git', ['push', '--follow-tags', 'origin', branch]) !== 0) {
	fail('git push failed. The commit and tag are local; fix the remote and push again.', rollback);
}

console.log(`\n${TAG} released ${tagName}.`);
