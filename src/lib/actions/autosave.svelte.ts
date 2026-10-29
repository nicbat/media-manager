import { untrack } from 'svelte';
import { toast } from 'svelte-sonner';

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

/**
 * Reactive controller returned by {@link createAutosave}. Read {@link status}/{@link saving} in markup
 * for the "Saving…/Saved" hint; call {@link commit} from the events that should persist; call
 * {@link cancel} to drop a pending safety-net save (e.g. just before a delete).
 */
export interface AutosaveController {
	/** Current save lifecycle state, for the header hint. */
	readonly status: SaveStatus;
	/** True while this controller is saving; hosts must preserve newer outgoing edits separately. */
	readonly saving: boolean;
	/**
	 * Persist now if dirty. Wire to the **intentful** moments: field blur, a discrete change
	 * (checkbox/dropdown/picker/date/list edit), Enter, prev/next, and close. No-ops when clean or a
	 * save is already running. Returns false on failure or while busy so callers retain the editor;
	 * returns true only when the commit succeeds or the form is clean.
	 */
	commit(): Promise<boolean>;
	/** Drop the pending safety-net timer without saving (use before a destructive action). */
	cancel(): void;
}

/**
 * Shared autosave wiring for the three editor panels (Records detail pane, Files per-file editor,
 * Globals editor). It owns the bits every panel used to re-hand-roll: the `saving`/`status` state,
 * the in-flight guard, the error toast, and a **single idle safety-net timer**.
 *
 * Cadence (Item: autosave rework). Saving is driven by **intent**, not by every keystroke: the host
 * calls {@link AutosaveController.commit} on field blur, discrete changes, Enter, prev/next, and close.
 * This controller adds only a slow `safetyDelay` (default **3s**) idle fallback that fires while
 * `isDirty()` stays true — it exists solely to catch someone typing in a long textarea without ever
 * blurring. Because a save almost never lands mid-keystroke anymore, the host can patch its edited row
 * in place without the value being clobbered.
 *
 * The `save()` routine is wrapped in {@link untrack} so reading/writing `$state` inside it never
 * adds incidental dependencies to the safety effect. Dirty state and the in-flight flag re-arm
 * the timer, including when newer edits remain after a save completes.
 *
 * @param opts.isDirty - Reactive predicate: true when the form differs from the last saved baseline.
 *   Together with the in-flight flag, it controls the safety timer.
 * @param opts.save - The async persistence routine. It should write the change, advance its own saved
 *   baseline, and notify the host (`onchanged`/`onSaved`). It must **throw** on failure — this
 *   controller turns a throw into `status='error'` + a toast. It must **not** touch `saving`/`status`
 *   (the controller owns them).
 * @param opts.safetyDelay - Idle-fallback debounce in ms (default 3000). Pass 0 to disable it entirely
 *   (pure intent-driven saving).
 * @param opts.errorMessage - Toast shown when `save()` throws (default "Failed to save").
 *
 * Concerns / future improvements:
 * - `save()` overlap is prevented only by the `saving` guard + cancelling the pending timer; this does
 *   not queue a follow-up save for edits made during an in-flight write — the next `commit()`/safety
 *   tick picks them up (they keep `isDirty()` true).
 */
export function createAutosave(opts: {
	isDirty: () => boolean;
	save: () => Promise<void>;
	safetyDelay?: number;
	errorMessage?: string;
}): AutosaveController {
	const { isDirty, save, safetyDelay = 3000, errorMessage = 'Failed to save' } = opts;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let status = $state<SaveStatus>('idle');
	let saving = $state(false);

	function cancel() {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
	}

	/** Run the host's save once, owning the status/in-flight/error bookkeeping. */
	async function run() {
		if (saving) return false;
		if (!untrack(isDirty)) return true;
		saving = true;
		status = 'saving';
		try {
			await untrack(() => save());
			status = 'saved';
			return true;
		} catch (e) {
			console.error(e);
			status = 'error';
			toast.error(errorMessage);
			return false;
		} finally {
			saving = false;
		}
	}

	// Idle safety-net only: while dirty, (re)arm a slow timer that flushes if the user never blurs.
	$effect(() => {
		// Re-arm after an in-flight save settles even if dirty stayed true throughout it.
		// Otherwise a blur that cancels the timer while saving can strand newer keystrokes.
		if (saving || safetyDelay <= 0 || !isDirty()) return;
		cancel();
		timer = setTimeout(() => {
			timer = null;
			void run();
		}, safetyDelay);
		return cancel;
	});

	return {
		get status() {
			return status;
		},
		get saving() {
			return saving;
		},
		async commit() {
			cancel();
			return await run();
		},
		cancel
	};
}
