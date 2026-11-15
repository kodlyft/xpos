<script setup lang="ts">
import { Info } from "@lucide/vue";
import { useApp } from "@mobile/composables/useApp";

const { state } = useApp();
</script>

<template>
	<div
		v-if="state.kind === 'web-dev' || (state.phase === 'unlocked' && !state.online)"
		class="pad-safe-top shrink-0"
	>
		<div class="pad-safe-x space-y-1 pt-2" role="note">
			<p
				v-if="state.kind === 'web-dev'"
				class="flex items-center gap-2 rounded-xl border border-info/30 bg-info-soft px-3 py-1.5 text-xs font-semibold text-info-soft-foreground"
			>
				<Info class="size-3.5 shrink-0" aria-hidden="true" />
				Browser dev mode: not Keystore-secured, no scanner or printer. Not for production.
			</p>
			<p
				v-if="state.phase === 'unlocked' && !state.online"
				class="flex items-center gap-2 rounded-xl border border-warning/30 bg-warning-soft px-3 py-1.5 text-xs font-semibold text-warning-soft-foreground"
			>
				<Info class="size-3.5 shrink-0" aria-hidden="true" />
				Offline: the catalog works, but charging is switched off until the server is reachable. Saved
				sales are kept and sent later.
			</p>
		</div>
	</div>
</template>
