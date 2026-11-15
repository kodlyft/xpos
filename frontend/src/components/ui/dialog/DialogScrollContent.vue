<script setup lang="ts">
import { __, cn } from "@/lib/utils";
import {
	DialogClose,
	DialogContent,
	type DialogContentEmits,
	type DialogContentProps,
	DialogOverlay,
	DialogPortal,
	useForwardPropsEmits,
} from "radix-vue";
import { computed, type HTMLAttributes } from "vue";
import { X } from "lucide-vue-next";

const props = defineProps<DialogContentProps & { class?: HTMLAttributes["class"]; hideClose?: boolean }>();
const emits = defineEmits<DialogContentEmits>();

const delegatedProps = computed(() => {
	const { class: _, ...delegated } = props;
	return delegated;
});

const forwarded = useForwardPropsEmits(delegatedProps, emits);

function keepOpenForToast(event: Event) {
	const target = (event as CustomEvent<{ originalEvent: Event }>).detail?.originalEvent?.target;
	if (target instanceof Element && target.closest("[data-toast-host]")) event.preventDefault();
}
</script>

<template>
	<DialogPortal to="body">
		<DialogOverlay class="dialog-overlay fixed inset-0 z-9999 bg-scrim/35" />
		<DialogContent
			v-bind="forwarded"
			@interact-outside="keepOpenForToast"
			:class="
				cn(
					'dialog-panel fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-9999 flex flex-col rounded-3xl border border-border bg-surface-raised text-card-foreground shadow-overlay overflow-hidden max-h-[90vh] w-[90vw]',
					props.class,
				)
			"
		>
			<slot />

			<DialogClose
				v-if="!hideClose"
				class="absolute inset-e-4 top-4 inline-flex size-10 items-center justify-center rounded-xl border border-border bg-card text-muted-foreground shadow-raised transition-[background-color,box-shadow,color] duration-fast hover:bg-surface-hover hover:text-foreground active:shadow-pressed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:pointer-events-none"
			>
				<X class="w-5 h-5" />
				<span class="sr-only">{{ __("Close") }}</span>
			</DialogClose>
		</DialogContent>
	</DialogPortal>
</template>
