<script setup lang="ts">
import StatusStrip from "./StatusStrip.vue";
</script>

<template>
	<div class="flex h-full min-h-0 flex-col bg-background text-foreground">
		<StatusStrip />
		<slot name="header" />
		<main class="xpos-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain pb-3"><slot /></main>
		<nav v-if="$slots.nav" class="pad-safe-x pad-safe-bottom shrink-0 pt-1" aria-label="Main">
			<slot name="nav" />
		</nav>
	</div>
</template>
