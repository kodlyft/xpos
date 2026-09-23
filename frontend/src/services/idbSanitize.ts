/**
 * Deep-copy a value into plain data IndexedDB (and Electron IPC) can store: Vue proxies become
 * plain objects and arrays, Dates become ISO strings, functions and symbols are dropped.
 * Kept free of Dexie so it can be imported anywhere.
 */
export function sanitizeForIdb<T>(value: T): T {
	const visited = new WeakMap<object, unknown>();

	const walk = (input: unknown): unknown => {
		if (input === null || input === undefined) return input;

		const inputType = typeof input;
		if (inputType === "string" || inputType === "number" || inputType === "boolean") {
			return input;
		}

		if (inputType === "bigint") return input.toString();
		if (inputType === "function" || inputType === "symbol") return undefined;

		if (input instanceof Date) return input.toISOString();

		if (Array.isArray(input)) {
			const result: unknown[] = [];
			for (const entry of input) {
				const safeEntry = walk(entry);
				if (safeEntry !== undefined) result.push(safeEntry);
			}
			return result;
		}

		if (inputType === "object") {
			const objectInput = input as Record<string, unknown>;
			if (visited.has(objectInput)) {
				return visited.get(objectInput);
			}

			const result: Record<string, unknown> = {};
			visited.set(objectInput, result);

			for (const [key, val] of Object.entries(objectInput)) {
				const safeVal = walk(val);
				if (safeVal !== undefined) {
					result[key] = safeVal;
				}
			}

			return result;
		}

		return input;
	};

	return walk(value) as T;
}
