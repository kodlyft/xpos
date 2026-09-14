<template>
	<Dialog
		:open="open"
		@update:open="
			(val: boolean) => {
				if (!val) $emit('cancel');
			}
		"
	>
		<DialogContent class="max-w-sm">
			<DialogHeader>
				<div class="flex items-center gap-3">
					<div
						class="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
						:class="
							variant === 'destructive'
								? 'bg-destructive/10 text-destructive'
								: 'bg-primary/10 text-primary'
						"
					>
						<component :is="icon || AlertTriangle" class="w-4.5 h-4.5" />
					</div>
					<div class="text-start">
						<DialogTitle class="text-base">{{ title }}</DialogTitle>
						<DialogDescription v-if="description" class="text-xs mt-0.5">
							{{ description }}
						</DialogDescription>
					</div>
				</div>
			</DialogHeader>

			<DialogFooter>
				<Button variant="outline" class="flex-1" @click="$emit('cancel')">
					{{ cancelLabel || __("Cancel") }}
				</Button>
				<Button
					:variant="variant === 'destructive' ? 'destructive' : 'default'"
					class="flex-1"
					@click="$emit('confirm')"
				>
					{{ confirmLabel || __("Confirm") }}
				</Button>
			</DialogFooter>
		</DialogContent>
	</Dialog>
</template>

<script setup lang="ts">
import type { Component } from "vue";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AlertTriangle } from "lucide-vue-next";
import { __ } from "@/lib/translate";

withDefaults(
	defineProps<{
		open: boolean;
		title: string;
		description?: string;
		confirmLabel?: string;
		cancelLabel?: string;
		variant?: "default" | "destructive";
		icon?: Component;
	}>(),
	{
		variant: "default",
	},
);

defineEmits<{
	confirm: [];
	cancel: [];
}>();
</script>
