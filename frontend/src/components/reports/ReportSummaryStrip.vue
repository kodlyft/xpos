<script setup lang="ts">
import __ from "@/lib/translate";
import { formatReportSummaryValue, type ReportSummaryItem } from "@/services/reports";

defineProps<{ items: ReportSummaryItem[]; currency: string }>();

const INDICATOR: Record<string, string> = {
	green: "bg-success",
	red: "bg-destructive",
	orange: "bg-warning",
	blue: "bg-info",
};

function dot(item: ReportSummaryItem): string {
	return INDICATOR[String(item.indicator || item.color || "").toLowerCase()] ?? "";
}
</script>

<template>
	<dl
		v-if="items.length > 0"
		class="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6"
		:aria-label="__('Report summary')"
	>
		<div
			v-for="(item, index) in items"
			:key="`${item.label ?? 'summary'}-${index}`"
			class="min-w-0 rounded-2xl border border-border bg-card/50 px-3 py-2 shadow-raised"
		>
			<dt class="flex items-center gap-1.5 text-xs text-muted-foreground">
				<span
					v-if="dot(item)"
					class="h-2 w-2 shrink-0 rounded-full"
					:class="dot(item)"
					aria-hidden="true"
				/>
				<span class="truncate">{{ item.label || __("Summary") }}</span>
			</dt>
			<dd class="mt-0.5 truncate text-base font-semibold tabular-nums text-foreground">
				{{ formatReportSummaryValue(item, currency) }}
			</dd>
		</div>
	</dl>
</template>
