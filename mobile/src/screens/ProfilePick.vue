<script setup lang="ts">
import { ref } from "vue";
import { Button } from "@/components/ui/button";
import { XposLogo } from "@/components/ui/brand";
import { chooseProfile, useApp } from "@mobile/composables/useApp";
import { toastOn } from "@mobile/composables/useToast";

const { state } = useApp();
const busy = ref("");
const error = ref("");
toastOn(error);
async function pick(name: string) {
	busy.value = name;
	error.value = "";
	try {
		await chooseProfile(name);
	} catch (e) {
		error.value = e instanceof Error ? e.message : "Could not load that profile.";
	} finally {
		busy.value = "";
	}
}
</script>

<template>
	<div class="pad-safe-x mx-auto flex max-w-md flex-col gap-4 py-8">
		<XposLogo variant="full" :size="40" subtitle="Mobile" />
		<div>
			<h1 class="text-2xl font-bold">Choose a POS Profile</h1>
			<p class="mt-1 text-sm text-muted-foreground">
				This device sells for one profile (company, warehouse, prices, payment methods). You can only
				see the profiles you are assigned to.
			</p>
		</div>
		<ul class="flex flex-col gap-2">
			<li v-for="p in state.pending?.profiles ?? []" :key="p.name">
				<Button
					variant="outline"
					class="h-auto min-h-14 w-full flex-col items-start gap-0.5 rounded-xl py-2 text-start"
					:loading="busy === p.name"
					@click="pick(p.name)"
				>
					<span class="text-base font-semibold">{{ p.name }}</span>
					<span class="text-xs font-normal text-muted-foreground"
						>{{ p.company }} · {{ p.warehouse }}</span
					>
				</Button>
			</li>
		</ul>
	</div>
</template>
