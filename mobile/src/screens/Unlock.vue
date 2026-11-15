<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import { Button } from "@/components/ui/button";
import { XposLogo } from "@/components/ui/brand";
import PinPad from "@mobile/ui/PinPad.vue";
import { getContainer, signOut, unlocked, useApp } from "@mobile/composables/useApp";
import { toastOn } from "@mobile/composables/useToast";

const { state } = useApp();
const pin = ref("");
const busy = ref(false);
const error = ref("");
toastOn(error);
const retryAt = ref(0);
const now = ref(Date.now());
const tick = setInterval(() => (now.value = Date.now()), 500);
onBeforeUnmount(() => clearInterval(tick));
const waitSec = computed(() => Math.max(0, Math.ceil((retryAt.value - now.value) / 1000)));

async function attempt(p: string) {
	busy.value = true;
	error.value = "";
	const r = await getContainer().auth.unlock(p);
	busy.value = false;
	pin.value = "";
	if (r.ok) return unlocked();
	if (r.reason === "locked" || (r.reason === "wrong_pin" && r.retryInMs)) {
		retryAt.value = Date.now() + (r.retryInMs ?? 0);
		error.value = "Too many wrong PINs.";
	} else error.value = "Wrong PIN.";
}
</script>

<template>
	<div class="pad-safe-x mx-auto flex max-w-md flex-col gap-4 py-8">
		<XposLogo variant="full" :size="40" class="self-center" subtitle="Mobile" />
		<div class="text-center">
			<h1 class="text-2xl font-bold">Locked</h1>
			<p class="mt-1 text-sm text-muted-foreground">
				{{ state.cashier?.user }} · {{ state.cashier?.site }}
			</p>
			<p v-if="state.lockReason" class="mt-1 text-xs text-muted-foreground">{{ state.lockReason }}</p>
		</div>
		<p v-if="waitSec" class="text-center text-sm font-medium" role="status">
			Try again in {{ waitSec }}s.
		</p>
		<PinPad v-model="pin" label="PIN" :disabled="busy || waitSec > 0" @complete="attempt" />
		<p class="text-center text-xs text-muted-foreground">
			Unlocking works offline for this cashier only. It does not renew your ERPNext authorization.
		</p>
		<Button variant="ghost" class="h-11" @click="signOut">Sign out (switch cashier)</Button>
		<p class="text-center text-xs text-muted-foreground">
			Signing in as another cashier needs a connection to the server.
		</p>
	</div>
</template>
