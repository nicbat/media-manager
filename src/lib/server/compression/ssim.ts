import sharp from 'sharp';

/**
 * Structural similarity (SSIM) between an original image and its compressed derivative — the single
 * number behind "is this noticeable?" on the Compression page (Item 15).
 *
 * SSIM correlates with human judgement far better than PSNR, and crucially it needs **no new
 * dependency**: it is arithmetic over two raw greyscale buffers that `sharp` already produces for the
 * encode. Scores are stored on the derivative's manifest record at generation time and never recomputed
 * on read.
 *
 * ## Two simplifications, named rather than implied
 *
 * This is not textbook SSIM. It uses a **uniform 8×8 window** where the reference implementation uses an
 * 11×11 Gaussian, and it compares **luma only**, which systematically *over*-scores exactly the
 * chroma-subsampling artifacts WebP introduces around q80. Both are fine for ranking files against each
 * other — all the flagged list needs — and neither would be acceptable for publishing an absolute
 * quality claim.
 *
 * ## What this metric is blind to
 *
 * It compares the two buffers **as decoded**. A derivative that lost its EXIF orientation tag and
 * renders 90° rotated still scores ~0.99 — a perfect grade on a visibly broken image. Colour-profile
 * loss (P3 → untagged sRGB) is likewise invisible to a luma comparison. That is precisely why
 * orientation and ICC preservation is a hard **generator rule** (`sharp(src).rotate().withMetadata()`,
 * see `generate.ts`) rather than something this metric is trusted to catch. The safety net does not
 * cover the most probable failure mode.
 */

/** Longest edge both images are decoded down to before comparison — bounds cost, not accuracy. */
const COMPARE_MAX_EDGE = 512;

/** Sliding window size (px). Uniform, unlike the reference 11×11 Gaussian. */
const WINDOW = 8;

/** Window stride. Half-overlap: better coverage than a disjoint tiling, still cheap. */
const STRIDE = 4;

/** SSIM stabilizing constants for 8-bit data: (K·L)² with K₁=0.01, K₂=0.03, L=255. */
const C1 = (0.01 * 255) ** 2;
const C2 = (0.03 * 255) ** 2;

/**
 * Decode an image to a raw single-channel (luma) buffer at an exact size.
 *
 * `.rotate()` applies the EXIF orientation first, so a rotated original is compared in the same
 * orientation as its (already-baked) derivative rather than against a transposed buffer.
 *
 * @param input - Absolute path to the image.
 * @param width - Target width in pixels.
 * @param height - Target height in pixels.
 */
async function greyscaleRaw(input: string, width: number, height: number): Promise<Buffer> {
	return await sharp(input)
		.rotate()
		.resize(width, height, { fit: 'fill' })
		.greyscale()
		.raw()
		.toBuffer();
}

/**
 * Mean SSIM over all windows of two equally-sized single-channel buffers.
 *
 * @param a - Luma buffer of the original.
 * @param b - Luma buffer of the derivative (same dimensions).
 * @param width - Buffer width in pixels.
 * @param height - Buffer height in pixels.
 * @returns Mean SSIM in [0, 1]; `1` when the image is smaller than one window (nothing to compare).
 */
function meanSsim(a: Buffer, b: Buffer, width: number, height: number): number {
	if (width < WINDOW || height < WINDOW) return 1;
	const n = WINDOW * WINDOW;
	let total = 0;
	let windows = 0;

	for (let y = 0; y + WINDOW <= height; y += STRIDE) {
		for (let x = 0; x + WINDOW <= width; x += STRIDE) {
			let sumA = 0;
			let sumB = 0;
			let sumAA = 0;
			let sumBB = 0;
			let sumAB = 0;
			for (let wy = 0; wy < WINDOW; wy++) {
				const row = (y + wy) * width + x;
				for (let wx = 0; wx < WINDOW; wx++) {
					const va = a[row + wx];
					const vb = b[row + wx];
					sumA += va;
					sumB += vb;
					sumAA += va * va;
					sumBB += vb * vb;
					sumAB += va * vb;
				}
			}
			const muA = sumA / n;
			const muB = sumB / n;
			// Population variance/covariance (the standard SSIM formulation uses the unbiased form; the
			// difference is a 1/(n-1) scaling that shifts scores by well under the third decimal we store).
			const varA = sumAA / n - muA * muA;
			const varB = sumBB / n - muB * muB;
			const covAB = sumAB / n - muA * muB;

			total +=
				((2 * muA * muB + C1) * (2 * covAB + C2)) /
				((muA * muA + muB * muB + C1) * (varA + varB + C2));
			windows++;
		}
	}
	return windows === 0 ? 1 : total / windows;
}

/**
 * Compute the SSIM of a derivative against its original.
 *
 * Both images are decoded to a **matched** size — the derivative's own dimensions, capped to
 * {@link COMPARE_MAX_EDGE}. For a width-bearing (resized) preset that means the original is downscaled
 * to the derivative's size first, so the score measures **codec loss, not the resize**: a 400px
 * thumbnail scoring 0.96 is not "4% worse than the original photo", it is "a good 400px rendering". The
 * Compression page labels resized presets' scores accordingly.
 *
 * @param originalPath - Absolute path to the source image.
 * @param derivedPath - Absolute path to the generated derivative.
 * @returns SSIM rounded to three decimals, or `null` when either image could not be decoded (never
 *   throws — a missing score degrades the report, it must not fail a generation).
 *
 * Concerns / future improvements:
 * - Cost is tens of milliseconds against an encode measured in hundreds, so it is not worth caching or
 *   sampling further; if it ever is, sample a subset of windows rather than shrinking `COMPARE_MAX_EDGE`.
 */
export async function computeSsim(
	originalPath: string,
	derivedPath: string
): Promise<number | null> {
	try {
		const meta = await sharp(derivedPath).metadata();
		const dw = meta.width ?? 0;
		const dh = meta.height ?? 0;
		if (dw <= 0 || dh <= 0) return null;

		const scale = Math.min(1, COMPARE_MAX_EDGE / Math.max(dw, dh));
		const w = Math.max(1, Math.round(dw * scale));
		const h = Math.max(1, Math.round(dh * scale));

		const [a, b] = await Promise.all([
			greyscaleRaw(originalPath, w, h),
			greyscaleRaw(derivedPath, w, h)
		]);
		if (a.length !== b.length || a.length < w * h) return null;

		const score = meanSsim(a, b, w, h);
		if (!Number.isFinite(score)) return null;
		return Math.round(Math.min(1, Math.max(0, score)) * 1000) / 1000;
	} catch {
		return null;
	}
}
