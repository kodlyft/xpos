<template>
	<div
		class="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-border px-3 py-2 sm:px-4"
	>
		<div class="flex items-center gap-2 text-sm text-muted-foreground">
			<span>{{ startRecord }}-{{ endRecord }} {{ __("of") }} {{ total }}</span>
		</div>

		<nav class="flex items-center gap-1" :aria-label="__('Pagination')">
			<Button
				variant="ghost"
				size="icon-sm"
				:aria-label="__('First page')"
				:disabled="currentPage === 1"
				@click="goToPage(1)"
			>
				<ChevronsLeft class="h-4 w-4" />
			</Button>

			<Button
				variant="ghost"
				size="icon-sm"
				:aria-label="__('Previous page')"
				:disabled="currentPage === 1"
				@click="goToPage(currentPage - 1)"
			>
				<ChevronLeft class="h-4 w-4" />
			</Button>

			<template v-for="page in visiblePages" :key="page">
				<Button v-if="page === '...'" variant="ghost" size="icon-sm" disabled class="cursor-default">
					...
				</Button>
				<Button
					v-else
					:variant="page === currentPage ? 'default' : 'ghost'"
					:aria-current="page === currentPage ? 'page' : undefined"
					size="icon-sm"
					@click="goToPage(page as number)"
				>
					{{ page }}
				</Button>
			</template>

			<Button
				variant="ghost"
				size="icon-sm"
				:aria-label="__('Next page')"
				:disabled="currentPage === totalPages"
				@click="goToPage(currentPage + 1)"
			>
				<ChevronRight class="h-4 w-4" />
			</Button>

			<Button
				variant="ghost"
				size="icon-sm"
				:aria-label="__('Last page')"
				:disabled="currentPage === totalPages"
				@click="goToPage(totalPages)"
			>
				<ChevronsRight class="h-4 w-4" />
			</Button>
		</nav>

		<div class="flex items-center gap-2">
			<span class="hidden sm:inline text-sm text-muted-foreground">{{ __("Per page:") }}</span>
			<Select
				v-model="pageSizeStr"
				class="h-control-compact w-20"
				:aria-label="__('Per page:')"
				side="top"
				:items="pageSizes.map((size) => ({ label: String(size), value: String(size) }))"
			/>
		</div>
	</div>
</template>

<script setup lang="ts">
import { computed, watch, ref } from "vue";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-vue-next";
import __ from "@/lib/translate";
import { Select } from "../ui/select";

const props = withDefaults(
	defineProps<{
		total: number;
		pageSize: number;
		currentPage: number;
		pageSizes?: number[];
	}>(),
	{
		pageSizes: () => [20, 50, 100, 200],
	},
);

const emit = defineEmits<{
	(e: "update:currentPage", page: number): void;
	(e: "update:pageSize", size: number): void;
}>();

const pageSizeStr = ref(String(props.pageSize));

watch(pageSizeStr, (newSize) => {
	emit("update:pageSize", parseInt(newSize));
	emit("update:currentPage", 1);
});

watch(
	() => props.pageSize,
	(newSize) => {
		pageSizeStr.value = String(newSize);
	},
);

const totalPages = computed(() => Math.max(1, Math.ceil(props.total / props.pageSize)));

const startRecord = computed(() => {
	if (props.total === 0) return 0;
	return (props.currentPage - 1) * props.pageSize + 1;
});

const endRecord = computed(() => {
	return Math.min(props.currentPage * props.pageSize, props.total);
});

const visiblePages = computed(() => {
	const pages: (number | string)[] = [];
	const total = totalPages.value;
	const current = props.currentPage;

	if (total <= 7) {
		for (let i = 1; i <= total; i++) {
			pages.push(i);
		}
	} else {
		pages.push(1);

		if (current <= 3) {
			pages.push(2, 3, 4, 5, "...", total);
		} else if (current >= total - 2) {
			pages.push("...", total - 4, total - 3, total - 2, total - 1, total);
		} else {
			pages.push("...", current - 1, current, current + 1, "...", total);
		}
	}

	return pages;
});

function goToPage(page: number) {
	if (page >= 1 && page <= totalPages.value) {
		emit("update:currentPage", page);
	}
}
</script>
