const TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();

/** CRC32 of the UTF-8 bytes, as MariaDB's CRC32() returns it (unsigned). Used to compare with catalog_digest. */
export function crc32(text: string): number {
	let c = 0xffffffff;
	for (const b of new TextEncoder().encode(text)) c = TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}
