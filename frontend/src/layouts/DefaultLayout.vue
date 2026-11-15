<template>
	<div class="flex flex-col flex-1 min-h-0 overflow-hidden">
		<Navbar />
		<div class="flex-1 relative overflow-hidden">
			<Sidebar />
			<main class="h-full overflow-hidden">
				<slot />
			</main>
		</div>

		<nav
			class="safe-bottom z-40 shrink-0 border-t border-border bg-card/95 backdrop-blur-md md:hidden"
			:aria-label="__('Main')"
		>
			<div class="flex h-14 items-stretch justify-around px-1">
				<router-link
					v-for="link in links"
					:key="link.to"
					:to="link.to"
					:aria-current="link.active ? 'page' : undefined"
					:class="[
						'relative flex min-w-16 flex-1 flex-col items-center justify-center gap-0.5 rounded-lg no-underline transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus',
						link.active
							? 'text-primary before:absolute before:inset-x-5 before:top-0 before:h-0.5 before:rounded-full before:bg-primary'
							: 'text-muted-foreground active:bg-surface-pressed',
					]"
				>
					<component :is="link.icon" class="size-5" aria-hidden="true" />
					<span class="text-[0.6875rem] font-semibold">{{ link.label }}</span>
				</router-link>
				<button
					type="button"
					class="flex min-w-16 flex-1 flex-col items-center justify-center gap-0.5 rounded-lg text-muted-foreground transition-colors active:bg-surface-pressed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
					@click="openSidebar"
				>
					<AlignJustify class="size-5" aria-hidden="true" />
					<span class="text-[0.6875rem] font-semibold">{{ __("Menu") }}</span>
				</button>
			</div>
		</nav>
	</div>
</template>

<script setup lang="ts">
import Navbar from "@/components/Navbar.vue";
import Sidebar from "@/components/Sidebar.vue";
import { computed } from "vue";
import { useRoute } from "vue-router";
import { LayoutGrid, FileText, BarChart3, AlignJustify, ScrollText } from "lucide-vue-next";
import { usePosStore } from "@/stores/posStore";
import __ from "@/lib/translate";

const route = useRoute();
const posStore = usePosStore();

const links = computed(() => [
	{ to: "/pos", label: __("POS"), icon: LayoutGrid, active: route.path === "/pos" },
	{ to: "/orders", label: __("Orders"), icon: FileText, active: route.path === "/orders" },
	...(posStore.allowSalesOrder
		? [
				{
					to: "/sales-orders",
					label: __("Sales Orders"),
					icon: ScrollText,
					active: route.path === "/sales-orders",
				},
			]
		: []),
	{ to: "/reports", label: __("Reports"), icon: BarChart3, active: route.path.startsWith("/reports") },
]);

function openSidebar() {
	window.dispatchEvent(new CustomEvent("xpos:toggle-sidebar"));
}
</script>
