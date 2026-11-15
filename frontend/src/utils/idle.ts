/** Run `task` when the browser is idle, or soon after if it never is. */
export function onIdle(task: () => void, timeout = 2000): void {
	if (typeof requestIdleCallback === "function") {
		requestIdleCallback(task, { timeout });
	} else {
		setTimeout(task, 200);
	}
}
