<script setup lang="ts">
import { ref } from "vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LoginError } from "@mobile/adapters/onlineLogin";
import { OfflineError } from "@mobile/adapters/frappeHttp";
import { reSignIn, useApp } from "@mobile/composables/useApp";
import { toastOn } from "@mobile/composables/useToast";

const { state } = useApp();
const password = ref("");
const error = ref("");
toastOn(error);
const busy = ref(false);
async function submit() {
	busy.value = true;
	error.value = "";
	try {
		await reSignIn(password.value);
		password.value = "";
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
</script>

<template>
	<div
		v-if="state.sessionExpired && state.phase === 'unlocked'"
		class="fixed inset-0 z-40 flex items-end justify-center bg-[hsl(var(--scrim)/0.5)] md:items-center"
	>
		<form
			class="w-full space-y-3 rounded-t-2xl border border-border bg-card p-4 shadow-overlay md:max-w-sm md:rounded-2xl"
			role="dialog"
			aria-modal="true"
			aria-label="Sign in again"
			@submit.prevent="submit"
		>
			<h2 class="text-lg font-bold">Sign in again</h2>
			<p class="text-sm text-muted-foreground">
				The server session for {{ state.cashier?.user }} has expired. Your cart and saved sales are
				untouched and will be sent after you sign in.
			</p>
			<Input
				v-model="password"
				type="password"
				autocomplete="current-password"
				class="h-11 text-base"
				placeholder="ERPNext password"
				aria-label="ERPNext password"
			/>
			<Button
				type="submit"
				class="h-12 w-full text-base font-semibold"
				:loading="busy"
				:disabled="!password"
				>Sign in</Button
			>
		</form>
	</div>
</template>
