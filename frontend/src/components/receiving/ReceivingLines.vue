<script setup lang="ts">
import { CornerDownLeft } from "lucide-vue-next";
import { Badge } from "@/components/ui/badge";
import { NumberInput } from "@/components/ui/number-input";
import { useMoney } from "@/composables/useMoney";
import { lineIssues } from "@/services/receivingRules";
import type { ReceivingLine } from "@/types/receiving.types";
import __ from "@/lib/translate";

defineProps<{ lines: ReceivingLine[]; showRates: boolean; disabled?: boolean }>();

const emit = defineEmits<{ (e: "change"): void }>();

const { money, qty: fmtQty } = useMoney();

function allOf(line: ReceivingLine): void {
	line.qty = line.pending_qty;
	line.return_qty = 0;
	emit("change");
}

function noneOf(line: ReceivingLine): void {
	line.qty = 0;
	emit("change");
}
</script>

<template>
	<div class="divide-y divide-border" role="list" :aria-label="__('Items in transit')">
		<div
			v-for="line in lines"
			:key="line.ste_detail"
			role="listitem"
			class="px-3 py-3 sm:px-4"
			:class="line.qty > 0 ? 'bg-card' : 'bg-card/40'"
		>
			<div class="flex flex-wrap items-start gap-x-4 gap-y-2">
				<div class="min-w-0 flex-1 basis-56">
					<div class="flex items-center gap-2">
						<p class="truncate text-sm font-semibold text-foreground">{{ line.item_name }}</p>
						<Badge v-if="line.variant_of" variant="outline">{{ __("Variant") }}</Badge>
						<Badge v-if="line.has_batch_no" variant="secondary">{{ __("Batch") }}</Badge>
						<Badge v-if="line.has_serial_no" variant="secondary">{{ __("Serial") }}</Badge>
					</div>
					<p class="truncate text-xs text-muted-foreground">
						{{ line.item_code }} · {{ line.uom }}
						<template v-if="line.conversion_factor !== 1">
							(× {{ line.conversion_factor }} {{ line.stock_uom }})
						</template>
					</p>
				</div>

				<dl class="grid grid-cols-3 gap-x-4 text-center text-xs text-muted-foreground">
					<div>
						<dt>{{ __("Sent") }}</dt>
						<dd class="text-sm font-medium tabular-nums text-foreground">
							{{ fmtQty(line.sent_qty) }}
						</dd>
					</div>
					<div>
						<dt>{{ __("Received") }}</dt>
						<dd class="text-sm font-medium tabular-nums text-foreground">
							{{ fmtQty(line.received_qty) }}
						</dd>
					</div>
					<div>
						<dt>{{ __("In transit") }}</dt>
						<dd class="text-sm font-medium tabular-nums text-foreground">
							{{ fmtQty(line.pending_qty) }}
						</dd>
					</div>
				</dl>

				<div class="flex flex-wrap items-end gap-2">
					<div class="w-28">
						<label
							class="mb-1 block text-xs text-muted-foreground"
							:for="`qty-${line.ste_detail}`"
							>{{ __("Receiving") }}</label
						>
						<NumberInput
							:id="`qty-${line.ste_detail}`"
							v-model="line.qty"
							:min="0"
							:max="line.pending_qty"
							:disabled="disabled"
							@change="emit('change')"
						/>
					</div>
					<div class="w-28">
						<label
							class="mb-1 flex items-center gap-1 text-xs text-muted-foreground"
							:for="`ret-${line.ste_detail}`"
						>
							<CornerDownLeft class="size-3 text-warning" />{{ __("Return") }}
						</label>
						<NumberInput
							:id="`ret-${line.ste_detail}`"
							v-model="line.return_qty"
							:min="0"
							:max="line.pending_qty"
							:disabled="disabled"
							@change="emit('change')"
						/>
					</div>
					<button
						type="button"
						class="h-control rounded-lg px-2 text-xs font-medium text-primary hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
						:disabled="disabled"
						@click="line.qty > 0 ? noneOf(line) : allOf(line)"
					>
						{{ line.qty > 0 ? __("None") : __("All") }}
					</button>
					<div v-if="showRates && line.rate !== null" class="w-24 text-end">
						<p class="mb-1 text-xs text-muted-foreground">{{ __("Value") }}</p>
						<p class="flex h-control items-center justify-end text-sm font-medium tabular-nums">
							{{ money(line.qty * line.rate) }}
						</p>
					</div>
				</div>
			</div>

			<ul v-if="lineIssues(line).length" class="mt-2 space-y-0.5" role="alert">
				<li v-for="issue in lineIssues(line)" :key="issue.message" class="text-xs text-destructive">
					{{ issue.message }}
				</li>
			</ul>
			<p
				v-else-if="
					line.pending_qty - line.qty - line.return_qty > 0 && (line.qty > 0 || line.return_qty > 0)
				"
				class="mt-2 text-xs text-warning"
			>
				{{
					__("{0} {1} stays in transit.")
						.replace("{0}", fmtQty(line.pending_qty - line.qty - line.return_qty))
						.replace("{1}", line.uom)
				}}
			</p>
			<p v-if="line.has_batch_no || line.has_serial_no" class="mt-1 text-xs text-muted-foreground">
				{{ __("Batches and serial numbers are taken from what was sent.") }}
			</p>
		</div>
	</div>
</template>
