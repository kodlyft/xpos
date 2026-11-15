<script setup lang="ts">
import { ref } from "vue";
import { Button } from "@/components/ui/button";
import { XposLogo } from "@/components/ui/brand";
import PinPad from "@mobile/ui/PinPad.vue";
import { enrolled, getContainer, useApp } from "@mobile/composables/useApp";
import { toastOn } from "@mobile/composables/useToast";

const { state } = useApp();
const first = ref("");
const second = ref("");
const step = ref<1 | 2>(1);
const error = ref("");
toastOn(error);
const busy = ref(false);

function onFirst() {
	step.value = 2;
}
async function onSecond(pin: string) {
	if (pin !== first.value) {
		error.value = "The PINs did not match. Start again.";
		first.value = second.value = "";
		step.value = 1;
		return;
	}
	busy.value = true;
	try {
		await getContainer().auth.enroll(JSON.parse(JSON.stringify(state.pending)), pin);
		await enrolled();
	} catch (e) {
		error.value = e instanceof Error ? e.message : "Could not save the PIN.";
	} finally {
		busy.value = false;
	}
}
</script>

<template>
	<div class="pad-safe-x mx-auto flex max-w-md flex-col gap-4 py-8">
		<XposLogo variant="full" :size="40" class="self-center" subtitle="Mobile" />
		<div>
			<h1 class="text-2xl font-bold">Set an unlock PIN</h1>
			<p class="mt-1 text-sm text-muted-foreground">
				Signed in as {{ state.pending?.user }}. The PIN unlocks this device offline for this cashier
				only. It is not your ERPNext password.
			</p>
		</div>
		<p class="text-center text-sm font-medium" aria-live="polite">
			{{ step === 1 ? "Choose a 6-digit PIN" : "Repeat the PIN" }}
		</p>
		<PinPad v-if="step === 1" v-model="first" label="New PIN" @complete="onFirst" />
		<PinPad v-else v-model="second" label="Repeat PIN" :disabled="busy" @complete="onSecond" />
		<Button v-if="step === 2" variant="ghost" @click="((step = 1), (first = second = ''))">Back</Button>
	</div>
</template>
