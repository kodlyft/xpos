<template>
	<div
		:role="urgent ? 'alert' : 'status'"
		:aria-live="urgent ? 'assertive' : 'polite'"
		aria-atomic="true"
		:data-toast-type="item.type"
		class="toast-item pointer-events-auto relative flex w-full items-start gap-3 overflow-hidden rounded-2xl border border-border bg-popover p-3 ps-4 text-popover-foreground shadow-overlay"
		@mouseenter="pause(item.id)"
		@mouseleave="resume(item.id)"
		@focusin="pause(item.id)"
		@focusout="onFocusOut"
	>
		<span class="absolute inset-y-0 inset-s-0 w-1" :class="accent" aria-hidden="true" />
		<span class="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full" :class="chip">
			<component
				:is="icon"
				class="size-4"
				:class="{ 'motion-safe:animate-spin': item.type === 'loading' }"
			/>
		</span>
		<div class="min-w-0 flex-1">
			<p
				class="max-h-40 overflow-y-auto whitespace-pre-line wrap-break-words text-sm font-medium leading-snug"
			>
				{{ item.message }}
				<span v-if="item.count > 1" class="ms-1 text-xs text-muted-foreground"
					>×{{ item.count }}</span
				>
			</p>
			<p
				v-if="item.description"
				class="mt-0.5 max-h-32 overflow-y-auto whitespace-pre-line wrap-break-words text-xs text-muted-foreground"
			>
				{{ item.description }}
			</p>
			<Button v-if="item.action" size="sm" variant="outline" class="mt-2" @click="runAction">
				{{ item.action.label }}
			</Button>
		</div>
		<button
			type="button"
			data-toast-dismiss
			:aria-label="__('Dismiss notification')"
			class="-me-1 -mt-1 inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
			@click="dismiss(item.id)"
		>
			<X class="size-4" />
		</button>
	</div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { AlertTriangle, CheckCircle2, Info, Loader2, X, XCircle } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { dismiss, pause, resume, type ToastItem } from "@/services/toast";
import __ from "@/lib/translate";

const props = defineProps<{ item: ToastItem }>();

const urgent = computed(() => props.item.type === "error" || props.item.type === "warning");

const STYLE = {
	success: {
		icon: CheckCircle2,
		accent: "bg-success",
		chip: "bg-success-soft text-success-soft-foreground",
	},
	error: {
		icon: XCircle,
		accent: "bg-destructive",
		chip: "bg-destructive-soft text-destructive-soft-foreground",
	},
	warning: {
		icon: AlertTriangle,
		accent: "bg-warning",
		chip: "bg-warning-soft text-warning-soft-foreground",
	},
	info: { icon: Info, accent: "bg-info", chip: "bg-info-soft text-info-soft-foreground" },
	loading: { icon: Loader2, accent: "bg-primary", chip: "bg-accent text-accent-foreground" },
} as const;

const icon = computed(() => STYLE[props.item.type].icon);
const accent = computed(() => STYLE[props.item.type].accent);
const chip = computed(() => STYLE[props.item.type].chip);

function onFocusOut(e: FocusEvent) {
	if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) resume(props.item.id);
}

function runAction() {
	props.item.action?.onClick();
	dismiss(props.item.id);
}
</script>
