/** Small synchronous, dependency-free hash for schema fingerprints (detects change; not a security boundary). */
export function fnv1a64(text: string): string {
	let h = 0xcbf29ce484222325n;
	const prime = 0x100000001b3n;
	for (const b of new TextEncoder().encode(text)) {
		h ^= BigInt(b);
		h = (h * prime) & 0xffffffffffffffffn;
	}
	return h.toString(16).padStart(16, "0");
}
