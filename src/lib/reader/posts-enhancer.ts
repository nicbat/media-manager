/**
 * `media-manager/reader/posts-enhancer` — a tiny, optional client-side progressive enhancement for
 * rendered posts (Item 14): it adds a "Copy" button to every code block. The reader's build-time
 * `html` is complete and readable without it; this just adds the copy affordance at runtime.
 *
 *   import { enhancePosts } from 'media-manager/reader/posts-enhancer';
 *   onMount(() => enhancePosts());
 *
 * The reader stays DOM-type-free (it compiles with `lib: ["ES2022"]`, no `DOM`), so this file reaches
 * the browser globals through `globalThis` with local `any` casts rather than DOM lib types. It no-ops
 * server-side (where `document` is undefined).
 */

/**
 * Attach a copy button to every `.shiki` / `.shiki-plain` code block under `root` (default: whole
 * document). Idempotent — a block already enhanced (marked `data-mm-enhanced`) is skipped, so calling
 * it after each post render is safe.
 *
 * @param root - Optional subtree to scope the enhancement to (an element); defaults to `document`.
 * @returns The number of code blocks newly enhanced.
 */
export function enhancePosts(root?: any): number {
	const g: any = globalThis as any;
	const doc: any = g.document;
	if (!doc) return 0;
	const scope: any = root ?? doc;
	const blocks: any[] = Array.from(scope.querySelectorAll('pre.shiki, pre.shiki-plain'));
	let count = 0;
	for (const pre of blocks) {
		if (pre.getAttribute('data-mm-enhanced') === '1') continue;
		pre.setAttribute('data-mm-enhanced', '1');

		const btn: any = doc.createElement('button');
		btn.type = 'button';
		btn.className = 'mm-copy-btn';
		btn.textContent = 'Copy';
		btn.addEventListener('click', () => {
			const code: string = (pre.querySelector('code')?.textContent ??
				pre.textContent ??
				'') as string;
			const nav: any = g.navigator;
			const done = () => {
				btn.textContent = 'Copied';
				g.setTimeout(() => (btn.textContent = 'Copy'), 1500);
			};
			if (nav?.clipboard?.writeText) {
				nav.clipboard.writeText(code).then(done, () => {});
			} else {
				done();
			}
		});
		pre.appendChild(btn);
		count++;
	}
	return count;
}
