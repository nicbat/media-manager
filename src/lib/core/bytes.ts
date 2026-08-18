/**
 * Human-readable byte sizes — client+server safe (no Node imports), like the rest of `core/`.
 *
 * Use case:
 * - The single formatter for every byte figure the UI shows: the All Files verbose grid's `file:size`,
 *   the Compression page's savings headline and per-preset/per-class rows, and the storage-migration
 *   preflight. These used to be per-file copies that drifted in their rounding and sign handling.
 */

/** Units above bytes, ascending. Binary (1024-based), matching what a file manager reports. */
const UNITS = ['KB', 'MB', 'GB', 'TB'] as const;

/**
 * Compact human byte size — `938 B`, `1.2 MB`, `-4.4 GB`.
 *
 * Whole numbers below 1 KiB (a fractional byte count is meaningless), one decimal above. Negative
 * inputs keep their sign rather than being clamped, so a "saved" figure that somehow went the wrong
 * way reads as the anomaly it is instead of silently rendering as a gain.
 *
 * @param bytes - A byte count.
 * @returns The formatted size.
 */
export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes)) return '—';
	const sign = bytes < 0 ? '-' : '';
	let v = Math.abs(bytes);
	if (v < 1024) return `${sign}${Math.round(v)} B`;
	v /= 1024;
	let i = 0;
	while (v >= 1024 && i < UNITS.length - 1) {
		v /= 1024;
		i++;
	}
	return `${sign}${v.toFixed(1)} ${UNITS[i]}`;
}
