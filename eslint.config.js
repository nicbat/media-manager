import js from '@eslint/js';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import svelteParser from 'svelte-eslint-parser';
import svelte from 'eslint-plugin-svelte';

/**
 * ESLint flat config for SvelteKit + Svelte 5 + TypeScript.
 *
 * Concerns / future improvements:
 * - Once this repo stabilizes, consider tightening rules (no-console, consistent-type-imports, etc.).
 */
export default [
	{
		ignores: ['.svelte-kit/**', 'build/**', 'dist/**', 'node_modules/**']
	},
	js.configs.recommended,
	{
		// Plain Node scripts (build/data tooling) run in Node, not the browser — they use `process`,
		// `console`, etc. ESLint's recommended config has no Node globals, so relax `no-undef` here
		// (same stance as the .ts/.svelte blocks below).
		files: ['scripts/**/*.{js,mjs,cjs}', 'bin/**/*.{js,mjs,cjs}', '*.{js,mjs,cjs}'],
		rules: {
			'no-undef': 'off'
		}
	},
	{
		files: ['**/*.ts'],
		languageOptions: {
			parser: tsParser,
			parserOptions: {
				ecmaVersion: 'latest',
				sourceType: 'module',
				project: './tsconfig.json'
			}
		},
		plugins: {
			'@typescript-eslint': tsPlugin
		},
		rules: {
			...tsPlugin.configs.recommended.rules,
			// Keep this relaxed for now; we can tighten after the refactor settles.
			'@typescript-eslint/no-explicit-any': 'off',
			// TS handles undefined globals better than ESLint in this repo’s mixed environments.
			'no-undef': 'off'
		}
	},
	...svelte.configs['flat/recommended'],
	{
		files: ['**/*.svelte', '**/*.svelte.ts'],
		languageOptions: {
			parser: svelteParser,
			parserOptions: {
				parser: tsParser,
				ecmaVersion: 'latest',
				sourceType: 'module',
				project: './tsconfig.json',
				extraFileExtensions: ['.svelte', '.svelte.ts']
			}
		},
		rules: {
			// Svelte templates often use unused vars for slots/snippets; keep relaxed.
			'no-unused-vars': 'off',
			'no-undef': 'off',
			// SvelteKit uses `goto` and `<a href>` without `resolve()` in many apps; keep relaxed.
			'svelte/no-navigation-without-resolve': 'off',
			// Generated UI components sometimes omit keys intentionally; keep relaxed.
			'svelte/require-each-key': 'off'
		}
	}
];
