<script setup lang="ts">
import { computed, ref } from "vue";
import { Button } from "@/components/ui/button";
import { XposLogo } from "@/components/ui/brand";
import { Input } from "@/components/ui/input";
import { isCleartext, validateServerOrigin } from "@mobile/domain/origin";
import { setOrigin, useApp } from "@mobile/composables/useApp";
import { WEB_DEV } from "@mobile/app/container";

const ALLOW_CLEARTEXT = WEB_DEV || import.meta.env.VITE_ALLOW_CLEARTEXT === "1";

const { state } = useApp();
const input = ref(state.origin ?? (state.kind === "web-dev" ? window.location.origin : ""));
const error = ref("");
const cleartext = computed(() => isCleartext(input.value));

function submit() {
	const r = validateServerOrigin(input.value, { allowCleartext: ALLOW_CLEARTEXT });
	if (!r.ok) {
		error.value = r.reason;
		return;
	}
	error.value = "";
	setOrigin(r.origin);
}
</script>

<template>
	<form class="pad-safe-x mx-auto flex max-w-md flex-col gap-4 py-8" novalidate @submit.prevent="submit">
		<XposLogo variant="full" :size="40" subtitle="Mobile" />
		<div>
			<h1 class="text-2xl font-bold">Connect to your server</h1>
			<p class="mt-1 text-sm text-muted-foreground">
				Enter the ERPNext address your business uses. XPOS Mobile needs ERPNext version 16 with XPOS
				installed.
			</p>
		</div>
		<div>
			<label for="origin" class="mb-1 block text-sm font-medium">Server address</label>
			<Input
				id="origin"
				v-model="input"
				class="h-11 text-base"
				type="url"
				inputmode="url"
				autocomplete="url"
				autocapitalize="none"
				spellcheck="false"
				placeholder="https://shop.example.com"
				:aria-invalid="!!error"
				:aria-describedby="error ? 'origin-err' : 'origin-hint'"
			/>
			<p v-if="error" id="origin-err" class="mt-1 text-sm text-destructive" role="alert">{{ error }}</p>
			<p v-else id="origin-hint" class="mt-1 text-xs text-muted-foreground">
				{{
					ALLOW_CLEARTEXT ? "Start with https:// (recommended) or http://." : "Start with https://."
				}}
				The app never guesses the server from anything else.
			</p>
			<p
				v-if="state.kind === 'web-dev'"
				class="mt-2 rounded-xl border border-info/30 bg-info-soft px-3 py-2 text-xs text-info-soft-foreground"
				role="note"
			>
				Browser development: requests to this address are forwarded by the Vite dev proxy to the
				ERPNext site set in .env.local.
			</p>
			<p
				v-if="cleartext"
				class="mt-2 rounded-xl border border-warning/30 bg-warning-soft px-3 py-2 text-xs text-warning-soft-foreground"
				role="note"
			>
				http:// is not encrypted. Your password and sales data can be read on the network. Use it only
				on a network you trust.
			</p>
		</div>
		<Button type="submit" class="h-12 rounded-xl text-base font-semibold">Continue</Button>
	</form>
</template>
