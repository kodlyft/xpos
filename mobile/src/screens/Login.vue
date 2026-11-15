<script setup lang="ts">
import { computed, ref } from "vue";
import { Button } from "@/components/ui/button";
import { XposLogo } from "@/components/ui/brand";
import { Input } from "@/components/ui/input";
import { isCleartext } from "@mobile/domain/origin";
import { LoginError } from "@mobile/adapters/onlineLogin";
import { OfflineError } from "@mobile/adapters/frappeHttp";
import { changeServer, getContainer, loggedIn, useApp } from "@mobile/composables/useApp";

const { state } = useApp();
const cleartext = computed(() => isCleartext(state.origin));
const user = ref("");
const password = ref("");
const busy = ref(false);
const error = ref("");

async function submit() {
	if (!user.value || !password.value) {
		error.value = "Enter your user name and password.";
		return;
	}
	busy.value = true;
	error.value = "";
	try {
		const info = await getContainer().auth.loginOnline(state.origin!, user.value.trim(), password.value);
		password.value = ""; // never kept after use
		loggedIn(info);
	} catch (e) {
		error.value =
			e instanceof LoginError
				? e.message
				: e instanceof OfflineError
					? "The server cannot be reached. Check the connection and the address."
					: "Sign-in failed. Try again.";
	} finally {
		busy.value = false;
	}
}
</script>

<template>
	<form class="pad-safe-x mx-auto flex max-w-md flex-col gap-4 py-8" novalidate @submit.prevent="submit">
		<XposLogo variant="full" :size="40" subtitle="Mobile" />
		<div>
			<h1 class="text-2xl font-bold">Sign in</h1>
			<p class="mt-1 break-all text-sm text-muted-foreground">Server: {{ state.origin }}</p>
			<p
				v-if="cleartext"
				class="mt-2 rounded-xl border border-warning/30 bg-warning-soft px-3 py-2 text-xs text-warning-soft-foreground"
				role="note"
			>
				This connection is not encrypted (http://). Your password will be sent in clear text.
			</p>
		</div>
		<div>
			<label for="usr" class="mb-1 block text-sm font-medium">User</label>
			<Input
				id="usr"
				v-model="user"
				class="h-11 text-base"
				type="text"
				autocomplete="username"
				autocapitalize="none"
				spellcheck="false"
				:disabled="busy"
			/>
		</div>
		<div>
			<label for="pwd" class="mb-1 block text-sm font-medium">Password</label>
			<Input
				id="pwd"
				v-model="password"
				class="h-11 text-base"
				type="password"
				autocomplete="current-password"
				:disabled="busy"
			/>
		</div>
		<p
			v-if="error"
			class="rounded-xl border border-destructive/30 bg-destructive-soft px-3 py-2 text-sm text-destructive-soft-foreground"
			role="alert"
		>
			{{ error }}
		</p>
		<Button type="submit" class="h-12 rounded-xl text-base font-semibold" :loading="busy">Sign in</Button>
		<Button type="button" variant="ghost" :disabled="busy" @click="changeServer">Change server</Button>
	</form>
</template>
