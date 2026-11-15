<template>
	<Teleport to="body">
		<TransitionGroup
			tag="div"
			data-toast-host
			name="toast"
			:aria-label="__('Notifications')"
			class="toast-host pointer-events-none fixed inset-x-0 bottom-0 z-10000 flex flex-col items-stretch gap-2 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:mx-auto sm:w-104"
		>
			<ToastItem v-for="t in visible" :key="t.id" :item="t" />
		</TransitionGroup>
	</Teleport>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted } from "vue";
import ToastItem from "./ToastItem.vue";
import { dispose, setDocumentHidden, visible } from "@/services/toast";
import __ from "@/lib/translate";

function onVisibility() {
	setDocumentHidden(document.hidden);
}

onMounted(() => {
	document.addEventListener("visibilitychange", onVisibility);
	onVisibility();
});

onBeforeUnmount(() => {
	document.removeEventListener("visibilitychange", onVisibility);
	dispose();
});
</script>

<style>
.toast-enter-active,
.toast-leave-active {
	transition:
		opacity var(--duration-base, 180ms) var(--ease-standard, ease),
		transform var(--duration-base, 180ms) var(--ease-standard, ease);
}
.toast-leave-active {
	position: absolute;
	inset-inline: 0.75rem;
}
.toast-enter-from,
.toast-leave-to {
	opacity: 0;
	transform: translateY(0.5rem);
}
.toast-move {
	transition: transform var(--duration-base, 180ms) var(--ease-standard, ease);
}
@media (prefers-reduced-motion: reduce) {
	.toast-enter-active,
	.toast-leave-active,
	.toast-move {
		transition: opacity 1ms;
	}
	.toast-enter-from,
	.toast-leave-to {
		transform: none;
	}
}
</style>
