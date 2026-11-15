<script setup lang="ts">
import type { Component, HTMLAttributes } from "vue";
import { cn } from "@/lib/utils";

const props = defineProps<{
	title: string;
	subtitle?: string;
	icon?: Component;
	class?: HTMLAttributes["class"];
}>();
</script>

<template>
	<header
		:class="
			cn(
				'flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-border bg-card px-3 py-3 sm:px-4',
				props.class,
			)
		"
	>
		<div class="flex min-w-0 items-center gap-2.5">
			<slot name="leading" />
			<component :is="icon" v-if="icon" class="size-5 shrink-0 text-primary" aria-hidden="true" />
			<div class="min-w-0">
				<h1 class="truncate text-lg font-semibold leading-tight text-foreground">{{ title }}</h1>
				<p v-if="subtitle" class="truncate text-xs text-muted-foreground">{{ subtitle }}</p>
			</div>
			<slot name="meta" />
		</div>
		<div v-if="$slots.default" class="flex flex-wrap items-center gap-2">
			<slot />
		</div>
	</header>
</template>
