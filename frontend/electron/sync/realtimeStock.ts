import { BrowserWindow, session } from "electron";
import { io, Socket } from "socket.io-client";
import { execute, queryOne } from "../database/dbService";
import { createLogger } from "../logger";

const log = createLogger("Realtime");

let socket: Socket | null = null;
let serverUrl = "";

function emitToRenderer(channel: string, data: unknown): void {
	const windows = BrowserWindow.getAllWindows();
	for (const win of windows) {
		if (!win.isDestroyed()) {
			win.webContents.send(channel, data);
		}
	}
}

export async function initRealtimeStock(url: string): Promise<void> {
	if (socket?.connected) {
		socket.disconnect();
	}

	serverUrl = url;

	let cookieHeader = "";
	try {
		const cookies = await session.defaultSession.cookies.get({ url: serverUrl });
		cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
	} catch {
		// Continue without cookies - server may reject
	}

	socket = io(serverUrl, {
		transports: ["websocket", "polling"],
		extraHeaders: cookieHeader ? { Cookie: cookieHeader } : undefined,
		reconnection: true,
		reconnectionDelay: 3000,
		reconnectionAttempts: Infinity,
	});

	socket.on("connect", () => {
		log.info(`Connected to ${serverUrl}`);

		socket!.emit("doctype_subscribe", "Bin");
		socket!.emit("doctype_subscribe", "Stock Ledger Entry");
	});

	socket.on("disconnect", (reason) => {
		log.info(`Disconnected: ${reason}`);
	});

	socket.on("list_update", async (data: { doctype: string; name?: string }) => {
		if (data.doctype === "Bin") {
			await handleBinUpdate(data.name);
		}
	});

	socket.on("doc_update", async (data: { doctype: string; name: string }) => {
		if (data.doctype === "Bin") {
			await handleBinUpdate(data.name);
		}
	});

	socket.on(
		"xpos_stock_update",
		async (data: { warehouse: string; item_code: string; actual_qty: number }) => {
			await updateLocalStock(data.warehouse, data.item_code, data.actual_qty);
			emitToRenderer("stock-updated", data);
		},
	);
}

async function handleBinUpdate(binName?: string): Promise<void> {
	if (!binName) return;

	try {
		const response = await fetch(`${serverUrl}/api/resource/Bin/${encodeURIComponent(binName)}`, {
			headers: { Accept: "application/json" },
		});
		if (!response.ok) return;

		const result = await response.json();
		const bin = result.data;
		if (bin?.warehouse && bin?.item_code) {
			await updateLocalStock(bin.warehouse, bin.item_code, bin.actual_qty || 0);
			emitToRenderer("stock-updated", {
				warehouse: bin.warehouse,
				item_code: bin.item_code,
				actual_qty: bin.actual_qty || 0,
			});
		}
	} catch {
		// Ignore fetch errors - will sync on next cycle
	}
}

async function updateLocalStock(warehouse: string, itemCode: string, actualQty: number): Promise<void> {
	try {
		await execute(
			`INSERT INTO \`stock_cache\` (\`cache_key\`, \`warehouse\`, \`item_code\`, \`actual_qty\`, \`updated_at\`)
       VALUES (?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE \`actual_qty\` = VALUES(\`actual_qty\`), \`updated_at\` = NOW()`,
			[`${warehouse}::${itemCode}`, warehouse, itemCode, actualQty],
		);
	} catch (err) {
		log.error("Failed to update local stock", err);
	}
}

export function disconnectRealtime(): void {
	if (socket) {
		socket.disconnect();
		socket = null;
	}
	log.info("Disconnected");
}

export function isRealtimeConnected(): boolean {
	return socket?.connected ?? false;
}
