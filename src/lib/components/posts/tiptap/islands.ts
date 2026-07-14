/**
 * Canonical `mm-*` photo-block markup — the single source of truth for the four island shapes in the
 * Posts block editor (Item 14, Phase 3). These exact HTML shapes are the contract shared by the
 * {@link HtmlIsland} node, the reader's island passthrough, and `posts.css` (plan appendix A).
 *
 * **Invariant (from the round-trip spike): no blank lines between an island's children.** A blank line
 * inside an island tears it into multiple `html_block` tokens (CommonMark HTML-block type 6 ends at a
 * blank line), breaking the byte-stable markdown round-trip. Every builder here emits its children on
 * contiguous lines. `mm://<uuid>` refs stay verbatim (the on-disk form).
 *
 * Editing is deterministic: {@link parseIsland} reads an island back into {@link IslandData}, the host
 * toolbar mutates fields, and {@link buildIsland} re-emits canonical markup. Merely *opening* a post
 * never rebuilds (the serializer writes stored markup verbatim) — only an explicit edit normalizes.
 */

/** Which of the four photo blocks an island is. */
export type IslandKind = 'mm-inline' | 'mm-beside' | 'mm-pair' | 'mm-bleed';

/** The editable fields of an island, union across all four kinds. */
export interface IslandData {
	kind: IslandKind;
	/** Primary image manifest id (bare uuid, no `mm://`). */
	uuid: string;
	alt?: string;
	caption?: string;
	/** `mm-beside` only: which side the image sits on. */
	side?: 'left' | 'right';
	/** `mm-beside` only: the prose column (plain text; wrapped in a single `<p>`). */
	text?: string;
	/** `mm-pair` only: the second image + its caption. */
	uuidB?: string;
	altB?: string;
	captionB?: string;
}

/** HTML-escape a text node value. */
function escText(v: string): string {
	return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** HTML-escape an attribute value (double-quoted context). */
function escAttr(v: string): string {
	return escText(v).replace(/"/g, '&quot;');
}

/** `<img src="mm://uuid" alt="…">` with an always-present (possibly empty) alt. */
function img(uuid: string, alt = ''): string {
	return `<img src="mm://${uuid}" alt="${escAttr(alt)}">`;
}

/** A `<figcaption>` line, or '' when there's no caption (so empty captions don't clutter the markup). */
function figcaption(caption?: string): string {
	const c = (caption ?? '').trim();
	return c ? `<figcaption>${escText(c)}</figcaption>` : '';
}

/**
 * Build canonical markup for an island. Children are emitted on contiguous lines (no blank lines) to
 * preserve the markdown round-trip invariant.
 *
 * @param data - The island's fields (see {@link IslandData}).
 * @returns The verbatim island HTML to store in `htmlIsland.attrs.html`.
 */
export function buildIsland(data: IslandData): string {
	const { kind } = data;
	if (kind === 'mm-inline') {
		return [
			'<figure class="mm-inline">',
			`  ${img(data.uuid, data.alt)}`,
			...(figcaption(data.caption) ? [`  ${figcaption(data.caption)}`] : []),
			'</figure>'
		].join('\n');
	}
	if (kind === 'mm-bleed') {
		return [
			'<figure class="mm-bleed">',
			`  ${img(data.uuid, data.alt)}`,
			...(figcaption(data.caption) ? [`  ${figcaption(data.caption)}`] : []),
			'</figure>'
		].join('\n');
	}
	if (kind === 'mm-beside') {
		const side = data.side === 'left' ? 'left' : 'right';
		const prose = escText((data.text ?? '').trim());
		return [
			`<div class="mm-beside" data-side="${side}">`,
			`  <div class="mm-text"><p>${prose}</p></div>`,
			`  <figure>${img(data.uuid, data.alt)}</figure>`,
			'</div>'
		].join('\n');
	}
	// mm-pair
	const capA = figcaption(data.caption);
	const capB = figcaption(data.captionB);
	return [
		'<div class="mm-pair">',
		`  <figure>${img(data.uuid, data.alt)}${capA}</figure>`,
		`  <figure>${img(data.uuidB ?? '', data.altB)}${capB}</figure>`,
		'</div>'
	].join('\n');
}

/**
 * Parse an island's markup back into {@link IslandData} for the edit toolbar. Browser-only (uses
 * `DOMParser`). Returns `null` if the markup isn't a recognized `mm-*` island.
 *
 * @param html - The stored island markup (`mm://` refs intact).
 */
export function parseIsland(html: string): IslandData | null {
	const doc = new DOMParser().parseFromString(html, 'text/html');
	const root = doc.body.firstElementChild;
	if (!root) return null;

	const mmUuid = (el: Element | null): string => {
		const src = el?.getAttribute('src') ?? '';
		const m = /^mm:\/\/(.+)$/.exec(src.trim());
		return m ? m[1] : '';
	};

	if (root.matches('figure.mm-inline') || root.matches('figure.mm-bleed')) {
		const imgEl = root.querySelector('img');
		return {
			kind: root.matches('figure.mm-bleed') ? 'mm-bleed' : 'mm-inline',
			uuid: mmUuid(imgEl),
			alt: imgEl?.getAttribute('alt') ?? '',
			caption: root.querySelector('figcaption')?.textContent ?? ''
		};
	}
	if (root.matches('div.mm-beside')) {
		const imgEl = root.querySelector('figure img');
		return {
			kind: 'mm-beside',
			uuid: mmUuid(imgEl),
			alt: imgEl?.getAttribute('alt') ?? '',
			side: root.getAttribute('data-side') === 'left' ? 'left' : 'right',
			text: root.querySelector('.mm-text')?.textContent ?? ''
		};
	}
	if (root.matches('div.mm-pair')) {
		const figs = Array.from(root.querySelectorAll('figure'));
		const a = figs[0],
			b = figs[1];
		return {
			kind: 'mm-pair',
			uuid: mmUuid(a?.querySelector('img') ?? null),
			alt: a?.querySelector('img')?.getAttribute('alt') ?? '',
			caption: a?.querySelector('figcaption')?.textContent ?? '',
			uuidB: mmUuid(b?.querySelector('img') ?? null),
			altB: b?.querySelector('img')?.getAttribute('alt') ?? '',
			captionB: b?.querySelector('figcaption')?.textContent ?? ''
		};
	}
	return null;
}
