/** A browser-safe random identity, including tills served over LAN HTTP. */
export function newInvoiceId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	return `inv_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
