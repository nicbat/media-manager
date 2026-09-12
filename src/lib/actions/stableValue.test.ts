import { describe, it, expect, afterEach } from 'vitest';
import { syncStableValue, stableValue } from './stableValue.js';

/**
 * Minimal stand-in for the only bits of an `<input>`/`<textarea>` these helpers touch. Enough to
 * assert the rule without pulling a DOM environment into a `node`-env test suite.
 */
function fakeField(value = '') {
	const listeners: Record<string, (() => void)[]> = {};
	return {
		value,
		addEventListener(type: string, fn: () => void) {
			(listeners[type] ??= []).push(fn);
		},
		removeEventListener(type: string, fn: () => void) {
			listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn);
		},
		/** Pretend the user left the field. */
		fireBlur() {
			for (const fn of listeners.blur ?? []) fn();
		},
		/** How many handlers are still attached (for the destroy assertion). */
		blurHandlerCount() {
			return (listeners.blur ?? []).length;
		}
	};
}

/** Point the stubbed `document.activeElement` at `el` (or nothing) for the duration of a test. */
function focus(el: unknown) {
	(globalThis as { document?: { activeElement: unknown } }).document = { activeElement: el };
}

afterEach(() => {
	delete (globalThis as { document?: unknown }).document;
});

describe('syncStableValue', () => {
	it('writes the value into an unfocused field', () => {
		const el = fakeField('old');
		focus(null);
		syncStableValue(el as never, 'new');
		expect(el.value).toBe('new');
	});

	it('refuses to write into the field the user is typing in', () => {
		// The regression this whole module exists for: a background refetch landing mid-sentence used
		// to overwrite the textarea, which moves the caret to the end and drops newer keystrokes.
		const el = fakeField('Thinking mid sentence about');
		focus(el);
		syncStableValue(el as never, 'Thinking mid');
		expect(el.value).toBe('Thinking mid sentence about');
	});

	it('skips a no-op write even when unfocused', () => {
		const el = fakeField('same');
		focus(null);
		let written = 0;
		Object.defineProperty(el, 'value', {
			get: () => 'same',
			set: () => {
				written++;
			}
		});
		syncStableValue(el as never, 'same');
		expect(written).toBe(0);
	});

	it('tolerates a missing element', () => {
		expect(() => syncStableValue(null, 'x')).not.toThrow();
		expect(() => syncStableValue(undefined, 'x')).not.toThrow();
	});
});

describe('stableValue action', () => {
	it('applies the initial value on mount', () => {
		const el = fakeField('');
		focus(null);
		stableValue(el as never, 'hello');
		expect(el.value).toBe('hello');
	});

	it('defers an update that arrives while focused, then applies it on blur', () => {
		const el = fakeField('typed by hand');
		focus(el);
		const handle = stableValue(el as never, 'from the server');
		expect(el.value).toBe('typed by hand');

		focus(null);
		el.fireBlur();
		expect(el.value).toBe('from the server');
		handle.destroy();
	});

	it('applies the latest deferred value, not an intermediate one', () => {
		const el = fakeField('typed by hand');
		focus(el);
		const handle = stableValue(el as never, 'first');
		handle.update('second');
		handle.update('third');
		expect(el.value).toBe('typed by hand');

		focus(null);
		el.fireBlur();
		expect(el.value).toBe('third');
		handle.destroy();
	});

	it('detaches its blur listener on destroy', () => {
		const el = fakeField('');
		focus(null);
		const handle = stableValue(el as never, 'x');
		expect(el.blurHandlerCount()).toBe(1);
		handle.destroy();
		expect(el.blurHandlerCount()).toBe(0);
	});
});
