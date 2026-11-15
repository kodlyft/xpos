<script setup lang="ts">
import { X } from "@lucide/vue";
import { dismissToast, toasts, type ToastKind } from "@mobile/composables/useToast";

const tone: Record<ToastKind, string> = {
	error: "border-destructive/30 bg-destructive-soft text-destructive-soft-foreground",
	warning: "border-warning/30 bg-warning-soft text-warning-soft-foreground",
	info: "border-info/30 bg-info-soft text-info-soft-foreground",
};
</script>

<template>
	<div
		class="pad-safe-x pointer-events-none fixed inset-x-0 top-0 z-[100] flex flex-col items-center gap-2 pt-[calc(env(safe-area-inset-top)+4.5rem)]"
		aria-live="polite"
	>
		<div
			v-for="t in toasts"
			:key="t.id"
			class="pointer-events-auto flex w-full max-w-md items-start gap-2 rounded-2xl border px-3 py-2.5 text-sm shadow-raised"
			:class="tone[t.kind]"
			:role="t.kind === 'error' ? 'alert' : 'status'"
		>
			<p class="min-w-0 flex-1 break-words">{{ t.text }}</p>
			<button
				type="button"
				class="-m-1 flex size-8 shrink-0 items-center justify-center rounded-full"
				aria-label="Dismiss"
				@click="dismissToast(t.id)"
			>
				<X class="size-4" aria-hidden="true" />
			</button>
		</div>
	</div>
</template>
