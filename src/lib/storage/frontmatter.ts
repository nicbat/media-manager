import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

/**
 * A parsed markdown post: its YAML frontmatter (as a plain object) and the raw markdown body that
 * follows the closing `---` fence.
 */
export interface ParsedPost {
	/** Frontmatter key/value pairs. `{}` when the document has no frontmatter block. */
	frontmatter: Record<string, unknown>;
	/** The markdown body after the frontmatter (leading blank line trimmed). */
	body: string;
}

/**
 * Matches a leading YAML frontmatter block: `---\n…\n---` at the very start of the file, consuming the
 * closing fence's newline **and** the single blank separator line that {@link serializeFrontmatter}
 * emits between the fence and the body (so parse ∘ serialize is the identity on the body).
 */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n(?:\r?\n)?/;

/**
 * Split a post's raw text into frontmatter + body (Item 14).
 *
 * The frontmatter is the leading `---`-fenced YAML block; everything after the closing fence is the
 * markdown body. A document with no frontmatter fence yields `{ frontmatter: {}, body: raw }`.
 * File-reference values (`cover: mm://<uuid>`) come back verbatim as strings — resolution to a URL is
 * the reader/editor's job, not the parser's.
 *
 * @param raw - The full `.md` file contents.
 * @returns The parsed frontmatter object and the remaining body.
 *
 * Concerns / future improvements:
 * - A non-object YAML frontmatter (e.g. a bare list) is coerced to `{}` — posts frontmatter is always
 *   a mapping.
 */
export function parseFrontmatter(raw: string): ParsedPost {
	const match = FRONTMATTER_RE.exec(raw);
	if (!match) {
		return { frontmatter: {}, body: raw };
	}
	const yamlText = match[1];
	const body = raw.slice(match[0].length);
	let frontmatter: Record<string, unknown> = {};
	try {
		const parsed = parseYaml(yamlText);
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			frontmatter = parsed as Record<string, unknown>;
		}
	} catch {
		frontmatter = {};
	}
	return { frontmatter, body };
}

/**
 * Serialize frontmatter + body back into a single `.md` document (Item 14).
 *
 * Inverse of {@link parseFrontmatter}. An empty (or all-empty) frontmatter object emits **no** fence —
 * just the body — so a post never grows a vestigial `---\n---`. String values like `mm://<uuid>`
 * round-trip verbatim (YAML plain scalars: a `:` not followed by whitespace does not force quoting).
 *
 * @param frontmatter - The frontmatter key/value pairs.
 * @param body - The markdown body.
 * @returns The full `.md` file contents (frontmatter fence + blank line + body).
 */
export function serializeFrontmatter(frontmatter: Record<string, unknown>, body: string): string {
	const keys = Object.keys(frontmatter ?? {});
	if (keys.length === 0) {
		return body;
	}
	// `lineWidth: 0` disables line-wrapping so long values (URLs, descriptions) stay on one line.
	const yamlText = stringifyYaml(frontmatter, { lineWidth: 0 }).trimEnd();
	return `---\n${yamlText}\n---\n\n${body}`;
}
