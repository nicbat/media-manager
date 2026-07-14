import { parse as parseYaml } from 'yaml';

/**
 * Reader-local frontmatter parser (Item 14).
 *
 * A byte-for-byte behavioral mirror of `src/lib/storage/frontmatter.ts` `parseFrontmatter`, duplicated
 * here so the reader stays a **self-contained** module (it can't import from `$lib/storage`, and the
 * whole `src/lib/reader/` tree is liftable into its own package — FUTURE_CHANGES Item 44). The reader
 * only ever *reads* posts, so there is no `serialize` counterpart. Keep the two parsers in lock-step.
 */

/** Matches a leading YAML frontmatter block + the single blank separator line the writer emits. */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n(?:\r?\n)?/;

/** A parsed post: its frontmatter object (`{}` when absent) and the markdown body after the fence. */
export interface ParsedPost {
	frontmatter: Record<string, unknown>;
	body: string;
}

/**
 * Split a post's raw `.md` text into frontmatter + body. A document with no `---` fence yields
 * `{ frontmatter: {}, body: raw }`. File-reference values (`cover: mm://<uuid>`) come back verbatim.
 *
 * @param raw - The full `.md` file contents.
 */
export function parseFrontmatter(raw: string): ParsedPost {
	const match = FRONTMATTER_RE.exec(raw);
	if (!match) return { frontmatter: {}, body: raw };
	const body = raw.slice(match[0].length);
	let frontmatter: Record<string, unknown> = {};
	try {
		const parsed = parseYaml(match[1]);
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			frontmatter = parsed as Record<string, unknown>;
		}
	} catch {
		frontmatter = {};
	}
	return { frontmatter, body };
}
