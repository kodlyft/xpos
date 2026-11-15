import type { PageCursor } from "./search";

export function encodeCursor(c: PageCursor): string {
	return btoa(unescape(encodeURIComponent(JSON.stringify([c.nameNorm, c.itemCode]))));
}

export function decodeCursor(s: string | undefined): PageCursor | null {
	if (!s) return null;
	try {
		const [nameNorm, itemCode] = JSON.parse(decodeURIComponent(escape(atob(s))));
		if (typeof nameNorm === "string" && typeof itemCode === "string") return { nameNorm, itemCode };
	} catch {
		/* fall through */
	}
	throw new RangeError("invalid page cursor");
}
