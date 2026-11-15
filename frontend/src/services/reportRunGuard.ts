/**
 * Hands out a token per run and answers whether a given token is still the latest. Report
 * switches, resets and newer runs all invalidate older in-flight work, so a slow response for
 * a previous report or filter set can never overwrite what is on screen.
 */
export function createRunGuard() {
	let current = 0;
	return {
		next(): number {
			current += 1;
			return current;
		},
		current(): number {
			return current;
		},
		isCurrent(token: number): boolean {
			return token === current;
		},
		cancel(): void {
			current += 1;
		},
	};
}
