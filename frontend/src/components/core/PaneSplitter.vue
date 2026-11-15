<template>
	<div
		role="separator"
		aria-orientation="vertical"
		tabindex="0"
		:aria-label="label"
		:aria-valuenow="Math.round(modelValue)"
		:aria-valuemin="min"
		:aria-valuemax="max"
		class="group relative z-10 flex w-3 shrink-0 cursor-col-resize touch-none items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
		@pointerdown="onPointerDown"
		@keydown="onKeydown"
		@dblclick="reset"
	>
		<span
			class="h-10 w-1 rounded-full bg-border transition-colors duration-fast group-hover:bg-muted-foreground/50 group-focus-visible:bg-primary"
			:class="dragging && 'bg-primary'"
			aria-hidden="true"
		/>
	</div>
</template>

<script setup lang="ts">
import { onUnmounted, ref } from "vue";

/**
 * Resizes the pane on its inline-end side (the cart). `modelValue` is that pane's width in px;
 * dragging toward the inline start makes it wider, in both LTR and RTL.
 */
const props = withDefaults(
	defineProps<{
		modelValue: number;
		min: number;
		max: number;
		defaultValue: number;
		label: string;
		step?: number;
		/** Where the resized pane sits: "end" (default) is the inline-end side, "start" the inline-start side. */
		side?: "start" | "end";
	}>(),
	{ step: 16, side: "end" },
);

const emit = defineEmits<{
	(e: "update:modelValue", value: number): void;
	/** Fired once a drag or key adjustment settles, for persisting. */
	(e: "commit", value: number): void;
}>();

const dragging = ref(false);
let startX = 0;
let startValue = 0;
let commitTimer: ReturnType<typeof setTimeout> | undefined;

const clamp = (value: number) => Math.min(props.max, Math.max(props.min, value));
const isRtl = () => document.documentElement.dir === "rtl";

function onPointerDown(event: PointerEvent) {
	if (event.button !== 0) return;
	dragging.value = true;
	startX = event.clientX;
	startValue = props.modelValue;
	(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
	window.addEventListener("pointermove", onPointerMove);
	window.addEventListener("pointerup", onPointerUp, { once: true });
	document.body.style.userSelect = "none";
}

function onPointerMove(event: PointerEvent) {
	const delta = (event.clientX - startX) * (isRtl() ? 1 : -1) * (props.side === "start" ? -1 : 1);
	emit("update:modelValue", clamp(startValue + delta));
}

function onPointerUp() {
	dragging.value = false;
	window.removeEventListener("pointermove", onPointerMove);
	document.body.style.userSelect = "";
	emit("commit", props.modelValue);
}

function set(value: number) {
	const next = clamp(value);
	emit("update:modelValue", next);
	clearTimeout(commitTimer);
	commitTimer = setTimeout(() => emit("commit", next), 400);
}

function onKeydown(event: KeyboardEvent) {
	// ArrowLeft moves the divider left: in LTR that widens the cart, in RTL it narrows it.
	const flip = isRtl() !== (props.side === "start");
	const towardStart = flip ? "ArrowRight" : "ArrowLeft";
	const towardEnd = flip ? "ArrowLeft" : "ArrowRight";
	if (event.key === towardStart) set(props.modelValue + props.step);
	else if (event.key === towardEnd) set(props.modelValue - props.step);
	else if (event.key === "Home") set(props.max);
	else if (event.key === "End") set(props.min);
	else return;
	event.preventDefault();
}

function reset() {
	set(props.defaultValue);
}

onUnmounted(() => {
	window.removeEventListener("pointermove", onPointerMove);
	clearTimeout(commitTimer);
});
</script>
