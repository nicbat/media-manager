import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Read a UTF-8 text file.
 *
 * @param filePath - Absolute file path
 * @returns File contents as string
 */
export async function readTextFile(filePath: string): Promise<string> {
	return await fs.readFile(filePath, 'utf-8');
}

/**
 * Write text atomically: write to a temp file then rename.
 *
 * @param filePath - Absolute file path
 * @param contents - UTF-8 contents to write
 *
 * Concerns / future improvements:
 * - On Windows, atomic replace behavior differs; consider `fs.rename` fallback strategy.
 */
export async function writeTextFileAtomic(filePath: string, contents: string): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	const tmpPath = `${filePath}.tmp-${randomUUID()}`;
	try {
		await fs.writeFile(tmpPath, contents, 'utf-8');
		await fs.rename(tmpPath, filePath);
	} finally {
		await fs.unlink(tmpPath).catch(() => {});
	}
}

/**
 * Read and parse a JSON file.
 *
 * @param filePath - Absolute file path
 * @returns Parsed JSON value
 */
export async function readJsonFile(filePath: string): Promise<unknown> {
	const text = await readTextFile(filePath);
	return JSON.parse(text);
}

/**
 * Stringify and write a JSON file atomically (pretty-printed).
 *
 * @param filePath - Absolute file path
 * @param value - Serializable JSON value
 */
export async function writeJsonFileAtomic(filePath: string, value: unknown): Promise<void> {
	const text = JSON.stringify(value, null, 2);
	await writeTextFileAtomic(filePath, text);
}
