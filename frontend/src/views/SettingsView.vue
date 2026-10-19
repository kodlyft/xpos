<template>
	<div class="flex flex-col h-full overflow-hidden bg-background">
		<div class="shrink-0 p-4 pb-3 border-b border-border">
			<h1 class="text-xl font-bold text-foreground">Settings</h1>
			<p class="text-sm text-muted-foreground mt-1">Configure your POS application</p>
		</div>

		<ScrollArea class="flex-1 p-4">
			<div class="max-w-2xl mx-auto space-y-6">
				<Card class="p-5">
					<div class="flex items-center gap-2 mb-4">
						<Globe class="w-5 h-5 text-primary" />
						<h2 class="text-base font-semibold text-foreground">Server Connection</h2>
					</div>
					<div class="space-y-3">
						<div>
							<label class="text-sm font-medium text-foreground">Server URL</label>
							<Input
								v-model="settings.serverUrl"
								placeholder="https://erp.example.com"
								class="mt-1"
							/>
							<p class="text-xs text-muted-foreground mt-1">
								The ERPNext server this POS connects to
							</p>
						</div>
						<div class="flex gap-2">
							<Button
								size="sm"
								variant="outline"
								@click="testServerConnection"
								:disabled="testingServer"
							>
								<Loader2 v-if="testingServer" class="w-4 h-4 me-1 animate-spin" />
								Test Connection
							</Button>
							<Button size="sm" @click="saveServerUrl" :disabled="!settings.serverUrl">
								Save
							</Button>
						</div>
					</div>
				</Card>

				<Card v-if="isElectronMode" class="p-5">
					<div class="flex items-center gap-2 mb-4">
						<Database class="w-5 h-5 text-primary" />
						<h2 class="text-base font-semibold text-foreground">Local Database</h2>
					</div>
					<div class="grid grid-cols-2 gap-3">
						<div>
							<label class="text-sm font-medium text-foreground">Host</label>
							<Input v-model="settings.dbHost" placeholder="127.0.0.1" class="mt-1" />
						</div>
						<div>
							<label class="text-sm font-medium text-foreground">Port</label>
							<Input v-model="settings.dbPort" type="number" placeholder="3306" class="mt-1" />
						</div>
						<div>
							<label class="text-sm font-medium text-foreground">Username</label>
							<Input v-model="settings.dbUser" placeholder="xpos" class="mt-1" />
						</div>
						<div>
							<label class="text-sm font-medium text-foreground">Password</label>
							<Input
								v-model="settings.dbPassword"
								type="password"
								placeholder="••••••"
								class="mt-1"
							/>
						</div>
						<div class="col-span-2">
							<label class="text-sm font-medium text-foreground">Database Name</label>
							<Input v-model="settings.dbName" placeholder="xpos_local" class="mt-1" />
						</div>
					</div>
					<div class="flex gap-2 mt-3">
						<Button size="sm" variant="outline" @click="testDbConnection" :disabled="testingDb">
							<Loader2 v-if="testingDb" class="w-4 h-4 me-1 animate-spin" />
							Test Connection
						</Button>
						<Button size="sm" @click="saveDbConfig"> Save & Reconnect </Button>
					</div>
				</Card>

				<Card v-if="isElectronMode" class="p-5">
					<div class="flex items-center gap-2 mb-4">
						<RefreshCw class="w-5 h-5 text-primary" />
						<h2 class="text-base font-semibold text-foreground">Synchronization</h2>
					</div>
					<div class="space-y-3">
						<div>
							<label class="text-sm font-medium text-foreground">
								Sync Interval (minutes)
							</label>
							<Input
								v-model.number="settings.syncInterval"
								type="number"
								min="1"
								max="60"
								class="mt-1 w-32"
							/>
						</div>
						<div class="flex items-center justify-between">
							<div>
								<p class="text-sm font-medium text-foreground">Auto Sync</p>
								<p class="text-xs text-muted-foreground">
									Automatically sync data in background
								</p>
							</div>
							<Checkbox v-model:checked="settings.autoSync" />
						</div>
						<Separator />
						<div class="flex items-center justify-between text-sm">
							<span class="text-muted-foreground">Last sync:</span>
							<span class="text-foreground">{{ syncState.lastSyncTime || "Never" }}</span>
						</div>
						<div class="flex items-center justify-between text-sm">
							<span class="text-muted-foreground">Pending records:</span>
							<Badge :variant="syncState.pendingPushCount > 0 ? 'destructive' : 'secondary'">
								{{ syncState.pendingPushCount }}
							</Badge>
						</div>
						<div class="flex gap-2">
							<Button
								size="sm"
								variant="outline"
								@click="triggerSync"
								:disabled="syncState.isSyncing"
							>
								<Loader2 v-if="syncState.isSyncing" class="w-4 h-4 me-1 animate-spin" />
								{{ syncState.isSyncing ? "Syncing..." : "Sync Now" }}
							</Button>
							<Button size="sm" @click="saveSyncSettings">Save</Button>
						</div>
					</div>
				</Card>

				<Card class="p-5">
					<div class="flex items-center gap-2 mb-4">
						<Monitor class="w-5 h-5 text-primary" />
						<h2 class="text-base font-semibold text-foreground">POS Profile</h2>
					</div>
					<div class="space-y-3">
						<div class="flex items-center justify-between text-sm">
							<span class="text-muted-foreground">Profile:</span>
							<span class="text-foreground font-medium">{{
								posStore.posProfile || "Not set"
							}}</span>
						</div>
						<div class="flex items-center justify-between text-sm">
							<span class="text-muted-foreground">Company:</span>
							<span class="text-foreground">{{ posStore.companyName || "-" }}</span>
						</div>
						<div class="flex items-center justify-between text-sm">
							<span class="text-muted-foreground">Warehouse:</span>
							<span class="text-foreground">{{ posStore.warehouse || "-" }}</span>
						</div>
					</div>
				</Card>

				<Card v-if="isElectronMode" class="p-5">
					<div class="flex items-center gap-2 mb-4">
						<HardDrive class="w-5 h-5 text-primary" />
						<h2 class="text-base font-semibold text-foreground">Data Management</h2>
					</div>
					<div class="space-y-3">
						<div class="flex items-center justify-between text-sm">
							<span class="text-muted-foreground">Local items:</span>
							<span class="text-foreground">{{ itemCount }}</span>
						</div>
						<Separator />
						<div class="flex gap-2 flex-wrap">
							<Button size="sm" variant="outline" @click="clearSyncData">
								Clear Synced Data
							</Button>
							<Button size="sm" variant="destructive" @click="clearAllLocalData">
								Clear All Local Data
							</Button>
						</div>
						<p class="text-xs text-muted-foreground">
							Clearing synced data will re-download on next sync. Pending records are not
							affected.
						</p>
					</div>
				</Card>

				<Card class="p-5">
					<div class="flex items-center gap-2 mb-4">
						<Info class="w-5 h-5 text-primary" />
						<h2 class="text-base font-semibold text-foreground">About</h2>
					</div>
					<div class="space-y-2 text-sm">
						<div class="flex items-center justify-between">
							<span class="text-muted-foreground">Version</span>
							<span class="text-foreground">{{ platformInfo.version || "-" }}</span>
						</div>
						<div class="flex items-center justify-between">
							<span class="text-muted-foreground">Platform</span>
							<span class="text-foreground">{{ platformInfo.platform || "Web" }}</span>
						</div>
						<div class="flex items-center justify-between">
							<span class="text-muted-foreground">Mode</span>
							<Badge variant="secondary">{{ isElectronMode ? "Desktop" : "Browser" }}</Badge>
						</div>
					</div>
				</Card>
			</div>
		</ScrollArea>
	</div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from "vue";
import { isElectron } from "@/services/electronBridge";
import { getSetting, setSetting, countItems, clearAllData } from "@/services/dbBridge";
import { usePosStore } from "@/stores/posStore";
import { toast } from "vue-sonner";

import { ScrollArea } from "@/components/ui/scroll-area";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Checkbox } from "@/components/ui/checkbox";
import { Globe, Database, RefreshCw, Monitor, HardDrive, Info, Loader2 } from "lucide-vue-next";

const posStore = usePosStore();
const isElectronMode = isElectron();

const settings = reactive({
	serverUrl: "",
	dbHost: "127.0.0.1",
	dbPort: 3306,
	dbUser: "xpos",
	dbPassword: "",
	dbName: "xpos_local",
	syncInterval: 5,
	autoSync: true,
});

const syncState = reactive({
	isSyncing: false,
	lastSyncTime: null as string | null,
	pendingPushCount: 0,
});

const platformInfo = reactive({
	version: "",
	platform: "",
});

const testingServer = ref(false);
const testingDb = ref(false);
const itemCount = ref(0);

onMounted(async () => {
	await loadSettings();
	if (isElectronMode) {
		await loadSyncState();
		await loadPlatformInfo();
		try {
			itemCount.value = await countItems();
		} catch {
			/* */
		}
	}
});

async function loadSettings() {
	try {
		if (isElectronMode) {
			const url = await window.electronAPI!.getServerUrl();
			settings.serverUrl = url || "";

			const dbConfig = await window.electronAPI!.db.getConfig();
			if (dbConfig) {
				settings.dbHost = (dbConfig.host as string) || "127.0.0.1";
				settings.dbPort = (dbConfig.port as number) || 3306;
				settings.dbUser = (dbConfig.user as string) || "xpos";
				settings.dbName = (dbConfig.database as string) || "xpos_local";
			}

			const interval = await getSetting("sync_interval");
			if (interval) settings.syncInterval = parseInt(interval, 10) || 5;

			const autoSync = await getSetting("auto_sync");
			settings.autoSync = autoSync !== "false";
		}
	} catch {
		/* use defaults */
	}
}

async function loadSyncState() {
	if (!isElectronMode) return;
	try {
		const state = await window.electronAPI!.getSyncState();
		syncState.isSyncing = state.isSyncing;
		syncState.lastSyncTime = state.lastSyncTime;
		syncState.pendingPushCount = state.pendingPushCount;
	} catch {
		/* */
	}
}

async function loadPlatformInfo() {
	if (!isElectronMode) return;
	try {
		const info = await window.electronAPI!.getPlatformInfo();
		platformInfo.version = info.version;
		platformInfo.platform = `${info.platform} (${info.arch})`;
	} catch {
		/* */
	}
}

async function testServerConnection() {
	if (!settings.serverUrl) return;
	testingServer.value = true;
	try {
		const resp = await fetch(`${settings.serverUrl}/api/method/frappe.ping`, {
			method: "GET",
			headers: { Accept: "application/json" },
		});
		if (resp.ok) {
			toast.success("Server is reachable");
		} else {
			toast.error("Server returned status" + ` ${resp.status}`);
		}
	} catch {
		toast.error("Cannot reach server");
	} finally {
		testingServer.value = false;
	}
}

async function saveServerUrl() {
	if (isElectronMode) {
		await window.electronAPI!.setServerUrl(settings.serverUrl);
	}
	await setSetting("server_url", settings.serverUrl, "connection");
	toast.success("Server URL saved");
}

async function testDbConnection() {
	if (!isElectronMode) return;
	testingDb.value = true;
	try {
		const result = await window.electronAPI!.db.testConnection({
			host: settings.dbHost,
			port: settings.dbPort,
			user: settings.dbUser,
			password: settings.dbPassword,
			database: settings.dbName,
		});
		if (result.success) {
			toast.success("Database connection successful");
		} else {
			toast.error(result.error || "Connection failed");
		}
	} catch (err) {
		toast.error("Connection test failed");
	} finally {
		testingDb.value = false;
	}
}

async function saveDbConfig() {
	if (!isElectronMode) return;
	try {
		const result = await window.electronAPI!.db.reinit({
			host: settings.dbHost,
			port: settings.dbPort,
			user: settings.dbUser,
			password: settings.dbPassword,
			database: settings.dbName,
		});
		if (result.success) {
			toast.success("Database reconnected successfully");
		} else {
			toast.error(result.error || "Reconnection failed");
		}
	} catch {
		toast.error("Failed to save database config");
	}
}

async function saveSyncSettings() {
	await setSetting("sync_interval", String(settings.syncInterval), "sync");
	await setSetting("auto_sync", String(settings.autoSync), "sync");
	toast.success("Sync settings saved");
}

async function triggerSync() {
	if (!isElectronMode) return;
	try {
		syncState.isSyncing = true;
		await window.electronAPI!.triggerSync();
		await loadSyncState();
	} catch {
		toast.error("Sync failed");
	}
}

async function clearSyncData() {
	if (!isElectronMode) return;
	if (!confirm("This will clear all synced master data. Pending records will not be affected. Continue?"))
		return;
	try {
		await window.electronAPI!.db.clearAllData();
		itemCount.value = 0;
		toast.success("Synced data cleared");
	} catch {
		toast.error("Failed to clear data");
	}
}

async function clearAllLocalData() {
	if (!isElectronMode) return;
	if (
		!confirm("This will clear ALL local data including pending records. This cannot be undone. Continue?")
	)
		return;
	try {
		await window.electronAPI!.db.clearAllData();
		await window.electronAPI!.db.clearPendingData();
		itemCount.value = 0;
		toast.success("All local data cleared");
	} catch {
		toast.error("Failed to clear data");
	}
}
</script>
