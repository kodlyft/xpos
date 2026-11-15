<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { KeyRound, Lock, LogOut, RefreshCw, Repeat } from "@lucide/vue";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LoginError } from "@mobile/adapters/onlineLogin";
import { OfflineError } from "@mobile/adapters/frappeHttp";
import {
	getContainer,
	lock,
	reSignIn,
	refreshContext,
	scopeIdFor,
	signOut,
	switchProfile,
	useApp,
} from "@mobile/composables/useApp";
import { toast, toastOn } from "@mobile/composables/useToast";

const { state } = useApp();
const cashier = computed(() => state.cashier!);
const ctx = computed(() => state.context);
const host = computed(() => new URL(cashier.value.site).host);
const initials = computed(() => (ctx.value.fullName ?? cashier.value.user).slice(0, 2).toUpperCase());

/** Plain labels for the POS permissions this user holds on the profile (set by the XPOS role, not by this app). */
const allowed = computed(() =>
	Object.entries(ctx.value.permissions)
		.filter(([, on]) => on)
		.map(([key]) => key.replaceAll("_", " ")),
);

const waiting = ref(0);
async function countWaiting() {
	const sales = await getContainer().transactions.listSales(
		["captured", "held", "uncertain", "posting", "reprice"],
		200,
	);
	waiting.value = sales.filter((s) => s.scopeId === scopeIdFor(cashier.value)).length;
}
onMounted(countWaiting);
watch(() => state.salesTick, countWaiting);

const password = ref("");
const busy = ref(false);
const error = ref("");
toastOn(error);
async function confirmPassword() {
	busy.value = true;
	error.value = "";
	try {
		await reSignIn(password.value);
		password.value = "";
		toast.info("Signed in again.");
	} catch (e) {
		error.value =
			e instanceof LoginError
				? e.message
				: e instanceof OfflineError
					? "The server cannot be reached."
					: "Could not sign in.";
	} finally {
		busy.value = false;
	}
}

const confirmOut = ref(false);
const profileChoice = ref("");
async function changeProfile() {
	busy.value = true;
	error.value = "";
	try {
		await switchProfile(profileChoice.value);
	} catch (e) {
		error.value = e instanceof Error ? e.message : "The profile could not be loaded.";
	} finally {
		busy.value = false;
	}
}
const others = computed(() => ctx.value.profiles.filter((p) => p.name !== cashier.value.profile));
</script>

<template>
	<div class="pad-safe-x mx-auto flex max-w-3xl flex-col gap-4 py-4">
		<section class="flex items-center gap-3 rounded-2xl border border-border bg-card p-4 shadow-raised">
			<Avatar
				><AvatarFallback>{{ initials }}</AvatarFallback></Avatar
			>
			<div class="min-w-0 flex-1">
				<p class="truncate text-lg font-bold">{{ ctx.fullName ?? cashier.user }}</p>
				<p class="truncate text-sm text-muted-foreground">{{ cashier.user }} · {{ host }}</p>
			</div>
			<Badge :variant="state.sessionExpired ? 'warning' : 'success'" dot>{{
				state.sessionExpired ? "Session expired" : state.online ? "Signed in" : "Offline"
			}}</Badge>
		</section>

		<section
			class="rounded-2xl border border-border bg-card p-4 shadow-raised"
			aria-label="Selling context"
		>
			<h2 class="mb-2 text-base font-bold">Where you sell</h2>
			<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
				<dt class="text-muted-foreground">POS Profile</dt>
				<dd class="font-medium">{{ cashier.profile }}</dd>
				<dt class="text-muted-foreground">Company</dt>
				<dd>{{ ctx.company }}</dd>
				<dt class="text-muted-foreground">Warehouse</dt>
				<dd>{{ ctx.warehouse }}</dd>
				<dt class="text-muted-foreground">Price list</dt>
				<dd>{{ ctx.priceList ?? "-" }}</dd>
				<dt class="text-muted-foreground">Default customer</dt>
				<dd>{{ ctx.customerName ?? ctx.customer ?? "-" }}</dd>
				<dt class="text-muted-foreground">Shift</dt>
				<dd>{{ ctx.openShift ?? "No shift open" }}</dd>
				<dt class="text-muted-foreground">Currency</dt>
				<dd>{{ cashier.currency }}</dd>
			</dl>
			<Button variant="outline" class="mt-3 h-11" :disabled="!state.online" @click="refreshContext"
				><RefreshCw /> Refresh from the server</Button
			>
		</section>

		<section
			class="rounded-2xl border border-border bg-card p-4 shadow-raised"
			aria-label="What you can do"
		>
			<h2 class="mb-1 text-base font-bold">What you can do</h2>
			<p class="mb-2 text-xs text-muted-foreground">
				Set by your XPOS role on this profile. Roles and users are managed in ERPNext and in the web
				POS under Role Permissions, not in this app.
			</p>
			<ul v-if="allowed.length" class="flex flex-wrap gap-1.5">
				<li v-for="a in allowed" :key="a">
					<Badge variant="secondary">{{ a }}</Badge>
				</li>
			</ul>
			<p v-else class="text-sm">Selling only. No extra permissions.</p>
		</section>

		<section
			class="space-y-3 rounded-2xl border border-border bg-card p-4 shadow-raised"
			aria-label="Account actions"
		>
			<h2 class="text-base font-bold">Account</h2>
			<Button variant="outline" class="h-11 w-full justify-start" @click="lock('Locked by the cashier')"
				><Lock /> Lock the app</Button
			>

			<form class="space-y-2" @submit.prevent="confirmPassword">
				<label class="flex items-center gap-2 text-sm font-medium" for="reauth"
					><KeyRound class="size-4" /> Confirm your ERPNext password</label
				>
				<div class="flex gap-2">
					<Input
						id="reauth"
						v-model="password"
						type="password"
						autocomplete="current-password"
						class="h-11 text-base"
						:disabled="!state.online"
					/>
					<Button type="submit" class="h-11" :loading="busy" :disabled="!password || !state.online"
						>Sign in</Button
					>
				</div>
				<p class="text-xs text-muted-foreground">
					Renews the server session. Unlocking the phone with the PIN works offline and only for
					{{ cashier.user }}.
				</p>
			</form>

			<form v-if="others.length" class="space-y-2" @submit.prevent="changeProfile">
				<label class="flex items-center gap-2 text-sm font-medium" for="profile"
					><Repeat class="size-4" /> Switch POS Profile</label
				>
				<div class="flex gap-2">
					<select
						id="profile"
						v-model="profileChoice"
						class="h-11 min-w-0 flex-1 rounded-lg border border-input bg-background px-2 text-base shadow-inset"
					>
						<option value="" disabled>Choose a profile</option>
						<option v-for="p in others" :key="p.name" :value="p.name">
							{{ p.name }} · {{ p.company }}
						</option>
					</select>
					<Button
						type="submit"
						class="h-11"
						:loading="busy"
						:disabled="!profileChoice || !state.online"
						>Switch</Button
					>
				</div>
				<p class="text-xs text-muted-foreground">
					The cart is cleared and a new PIN is set. Sales waiting under this profile stay on the
					phone and are sent when you switch back.
				</p>
			</form>

			<div class="border-t border-border pt-3">
				<template v-if="!confirmOut">
					<Button variant="outline" class="h-11 w-full justify-start" @click="confirmOut = true"
						><LogOut /> Sign out / change user</Button
					>
				</template>
				<div v-else class="space-y-2" role="alertdialog" aria-label="Confirm sign out">
					<p class="text-sm">
						Sign out {{ cashier.user }}? The unlock PIN for this phone is removed.
						<strong v-if="waiting"
							>{{ waiting }} sale{{ waiting === 1 ? " is" : "s are" }} still waiting to be sent;
							they stay on this phone and are sent only when {{ cashier.user }} signs in
							again.</strong
						>
					</p>
					<div class="flex gap-2">
						<Button variant="outline" class="h-11 flex-1" @click="confirmOut = false"
							>Cancel</Button
						>
						<Button variant="destructive" class="h-11 flex-1" @click="signOut">Sign out</Button>
					</div>
				</div>
			</div>
		</section>
	</div>
</template>
