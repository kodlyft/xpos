<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { X } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useApp } from "@mobile/composables/useApp";
import { useCart, lineKey } from "@mobile/composables/useCart";

/** A manual discount or price for one line. Offered only to users holding the permission; the server decides. */
const props = defineProps<{ lineKey: string | null }>();
const emit = defineEmits<{ close: [] }>();
const { state } = useApp();
const { cart } = useCart();
const line = computed(() => cart.lines.find((l) => lineKey(l) === props.lineKey));
const canDiscount = computed(() => !!state.context.permissions.show_edit_discount_field);
const canPrice = computed(() => !!state.context.permissions.allow_change_price);
const discount = ref("");
const price = ref("");
watch(
	line,
	(l) => {
		discount.value = l?.discountPct ? String(l.discountPct) : "";
		price.value = l?.rateOverride !== undefined ? String(l.rateOverride) : "";
	},
	{ immediate: true },
);

function save() {
	const l = line.value;
	if (!l) return;
	const d = Number(discount.value);
	const p = Number(price.value);
	if (canDiscount.value) {
		if (Number.isFinite(d) && d > 0) l.discountPct = d;
		else delete l.discountPct;
	}
	if (canPrice.value) {
		if (price.value.trim() !== "" && Number.isFinite(p) && p >= 0) l.rateOverride = p;
		else delete l.rateOverride;
	}
	emit("close");
}
</script>

<template>
	<div
		v-if="line"
		class="fixed inset-0 z-30 flex items-end justify-center bg-[hsl(var(--scrim)/0.5)] md:items-center"
		@click.self="emit('close')"
		@keydown.esc="emit('close')"
	>
		<form
			class="w-full space-y-3 rounded-t-2xl border border-border bg-card p-4 shadow-overlay md:max-w-sm md:rounded-2xl"
			role="dialog"
			aria-modal="true"
			:aria-label="`Adjust ${line.name}`"
			@submit.prevent="save"
		>
			<div class="flex items-center justify-between gap-2">
				<h2 class="min-w-0 truncate text-lg font-bold">{{ line.name }}</h2>
				<Button
					type="button"
					variant="ghost"
					size="icon"
					class="size-11"
					aria-label="Close"
					@click="emit('close')"
					><X
				/></Button>
			</div>
			<label v-if="canDiscount" class="block space-y-1 text-sm font-medium"
				>Discount (%)
				<Input v-model="discount" class="h-11 text-base tabular-nums" inputmode="decimal" />
			</label>
			<label v-if="canPrice" class="block space-y-1 text-sm font-medium"
				>Price per {{ line.uom }}
				<Input
					v-model="price"
					class="h-11 text-base tabular-nums"
					inputmode="decimal"
					placeholder="List price"
				/>
			</label>
			<p class="text-xs text-muted-foreground">
				These are checked again by ERPNext against your permission and discount limit. A refused
				change is explained on the cart.
			</p>
			<Button type="submit" class="h-12 w-full text-base font-semibold">Apply</Button>
		</form>
	</div>
</template>
