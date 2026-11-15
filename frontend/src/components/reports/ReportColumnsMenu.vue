<script setup lang="ts">
import { ArrowDown, ArrowUp, Columns3, Pin, PinOff } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContentStyled, PopoverTrigger } from "@/components/ui/popover";
import __ from "@/lib/translate";
import type { ReportColumn } from "@/services/reports";
import type { ReportLayout } from "@/services/reportGrid";

const props = defineProps<{
	columns: ReportColumn[];
	layout: ReportLayout;
}>();

const emit = defineEmits<{ (e: "change", layout: ReportLayout): void; (e: "reset"): void }>();

function orderedNames(): string[] {
	return props.columns.map((column) => column.fieldname);
}

function isHidden(name: string): boolean {
	return props.layout.hidden.includes(name);
}

function toggle(name: string) {
	const hidden = isHidden(name)
		? props.layout.hidden.filter((n) => n !== name)
		: [...props.layout.hidden, name];
	emit("change", { ...props.layout, order: orderedNames(), hidden });
}

function move(name: string, delta: -1 | 1) {
	const order = orderedNames();
	const from = order.indexOf(name);
	const to = from + delta;
	if (from < 0 || to < 0 || to >= order.length) return;
	[order[from], order[to]] = [order[to], order[from]];
	emit("change", { ...props.layout, order });
}

function freezeThrough(name: string) {
	const visible = props.columns.filter((column) => !isHidden(column.fieldname));
	const position = visible.findIndex((column) => column.fieldname === name) + 1;
	emit("change", {
		...props.layout,
		order: orderedNames(),
		frozen: props.layout.frozen === position ? 0 : position,
	});
}

function frozenThrough(name: string): boolean {
	const visible = props.columns.filter((column) => !isHidden(column.fieldname));
	return (
		props.layout.frozen > 0 && visible.findIndex((c) => c.fieldname === name) + 1 === props.layout.frozen
	);
}
</script>

<template>
	<Popover>
		<PopoverTrigger as-child>
			<Button variant="outline" size="sm" class="h-9 gap-1.5">
				<Columns3 class="h-4 w-4" aria-hidden="true" />
				{{ __("Columns") }}
			</Button>
		</PopoverTrigger>
		<PopoverContentStyled align="end" class="w-80">
			<div class="mb-2 flex items-center justify-between">
				<p class="text-sm font-semibold text-foreground">{{ __("Columns") }}</p>
				<Button variant="ghost" size="sm" class="h-8" @click="emit('reset')">{{
					__("Reset")
				}}</Button>
			</div>
			<ul class="max-h-80 space-y-0.5 overflow-auto" :aria-label="__('Column visibility and order')">
				<li
					v-for="(column, index) in columns"
					:key="column.fieldname"
					class="flex items-center gap-1 rounded-lg px-1 py-0.5 hover:bg-surface-hover"
				>
					<label class="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-sm">
						<Checkbox
							:checked="!isHidden(column.fieldname)"
							:aria-label="column.label"
							@update:checked="toggle(column.fieldname)"
						/>
						<span class="truncate">{{ column.label }}</span>
					</label>
					<Button
						variant="ghost"
						size="icon-sm"
						:disabled="index === 0"
						:aria-label="__('Move {0} earlier', [column.label])"
						@click="move(column.fieldname, -1)"
					>
						<ArrowUp class="h-3.5 w-3.5 rtl:-scale-x-100" />
					</Button>
					<Button
						variant="ghost"
						size="icon-sm"
						:disabled="index === columns.length - 1"
						:aria-label="__('Move {0} later', [column.label])"
						@click="move(column.fieldname, 1)"
					>
						<ArrowDown class="h-3.5 w-3.5" />
					</Button>
					<Button
						variant="ghost"
						size="icon-sm"
						:disabled="isHidden(column.fieldname)"
						:aria-pressed="frozenThrough(column.fieldname)"
						:aria-label="
							frozenThrough(column.fieldname)
								? __('Unfreeze columns')
								: __('Freeze columns up to {0}', [column.label])
						"
						@click="freezeThrough(column.fieldname)"
					>
						<PinOff v-if="frozenThrough(column.fieldname)" class="h-3.5 w-3.5" />
						<Pin v-else class="h-3.5 w-3.5" />
					</Button>
				</li>
			</ul>
		</PopoverContentStyled>
	</Popover>
</template>
