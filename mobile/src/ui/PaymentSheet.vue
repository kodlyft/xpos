<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Banknote, CreditCard, Gift, Plus, Trash2, X } from "@lucide/vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { settleTenders } from "@mobile/app/checkout";
import { checkGiftCard, takeIssuedCards, type IssuedCard } from "@mobile/app/giftCards";
import { formatMinor, toMinor } from "@mobile/domain/money";
import { describeSale, type SaleEvidence, type TenderEvidence } from "@mobile/domain/sale";
import { getContainer, useApp } from "@mobile/composables/useApp";
import { useCheckout } from "@mobile/composables/useCheckout";
import { useCustomer } from "@mobile/composables/useCustomer";
import { toast, toastOn } from "@mobile/composables/useToast";

const { state } = useApp();
const { flow, pay, payRepriced, finish, cancel } = useCheckout();
const { displayName: customerName } = useCustomer();
toastOn(() => flow.error, "warning");
const digits = computed(() => state.cashier?.minorDigits ?? 2);
const currency = computed(() => state.cashier?.currency ?? "");
const money = (m: number) => formatMinor(m, digits.value);

interface Row {
	mode: string;
	amount: string;
	reference: string;
	confirmed: boolean;
	/** A gift card tender: token from the live balance check, the card as shown on receipts, its balance. */
	giftAuth?: string;
	masked?: string;
	balanceMinor?: number;
}
const rows = ref<Row[]>([]);
const giftMode = computed(() => state.context.giftCards?.modeOfPayment ?? null);
/** Ordinary payment methods; the gift card mode is only reachable through a checked card. */
const modes = computed(() => state.context.paymentModes.filter((m) => m.mode_of_payment !== giftMode.value));
const canRedeem = computed(
	() =>
		flow.kind === "sale" &&
		!flow.reprice &&
		!!giftMode.value &&
		!!state.context.permissions.redeem_gift_card,
);
const typeOf = (mode: string) => modes.value.find((m) => m.mode_of_payment === mode)?.type ?? null;

/** Amount due: the new price after a re-price, otherwise ERPNext's quote. */
const due = computed(() => flow.reprice?.payableMinor ?? flow.quote?.payableMinor ?? 0);

function reset() {
	const def = modes.value.find((m) => m.default) ?? modes.value[0];
	rows.value = def
		? [{ mode: def.mode_of_payment, amount: money(due.value), reference: "", confirmed: false }]
		: [];
}
watch(
	() => [flow.step, due.value],
	() => flow.step === "paying" && reset(),
	{ immediate: true },
);

function tenders(): TenderEvidence[] | null {
	try {
		return rows.value.map((r) =>
			r.giftAuth
				? {
						mode: r.mode,
						type: "Gift Card",
						amountMinor: toMinor(r.amount || "0", digits.value),
						giftCardAuth: r.giftAuth,
						maskedCard: r.masked,
					}
				: {
						mode: r.mode,
						type: typeOf(r.mode),
						amountMinor: toMinor(r.amount || "0", digits.value),
						reference: r.reference.trim() || undefined,
						requiresReference: modes.value.find((m) => m.mode_of_payment === r.mode)
							?.requires_reference,
						terminalConfirmed: typeOf(r.mode) === "Cash" ? undefined : r.confirmed,
					},
		);
	} catch {
		return null;
	}
}
const check = computed(() => {
	const t = tenders();
	if (!t) return { ok: false as const, reason: "Enter amounts as numbers." };
	for (const [i, r] of rows.value.entries())
		if (r.giftAuth && t[i].amountMinor > (r.balanceMinor ?? 0))
			return {
				ok: false as const,
				reason: `${r.masked} only has ${money(r.balanceMinor ?? 0)} on it.`,
			};
	return settleTenders(due.value, t);
});

const giftCode = ref("");
const giftBusy = ref(false);
async function addGiftCard() {
	const e = state.cashier;
	if (!e || !giftCode.value.trim() || !giftMode.value) return;
	giftBusy.value = true;
	try {
		const api = await getContainer().session(e.site);
		const c = await checkGiftCard(api, e.profile, giftCode.value, e.minorDigits);
		if (rows.value.some((r) => r.masked === c.maskedCode))
			return void toast.warning("That card is already on this sale.");
		const left = Math.max(0, due.value - paid.value);
		rows.value.push({
			mode: giftMode.value,
			amount: money(Math.min(c.balanceMinor, left)),
			reference: "",
			confirmed: false,
			giftAuth: c.auth,
			masked: c.maskedCode,
			balanceMinor: c.balanceMinor,
		});
		giftCode.value = "";
	} catch (err) {
		toast.warning(err instanceof Error ? err.message : "The gift card could not be checked.");
	} finally {
		giftBusy.value = false;
	}
}
const paid = computed(() => {
	const t = tenders();
	return t ? t.reduce((s, x) => s + x.amountMinor, 0) : 0;
});

function addRow() {
	const m =
		modes.value.find((x) => !rows.value.some((r) => r.mode === x.mode_of_payment)) ?? modes.value[0];
	if (!m) return;
	rows.value.push({
		mode: m.mode_of_payment,
		amount: money(Math.max(0, due.value - paid.value)),
		reference: "",
		confirmed: false,
	});
}
async function submit() {
	const t = tenders();
	if (!t || !check.value.ok) return;
	if (flow.reprice && flow.sale) await payRepriced(flow.sale, t);
	else await pay(t);
}

/** Codes of cards just sold: held in memory only, shown here once. */
const issued = ref<IssuedCard[]>([]);
const codesSeen = ref(false);
watch(
	() => flow.sale?.txnId,
	() => {
		issued.value = [];
		codesSeen.value = false;
	},
);
watch(
	() => [flow.sale?.status, flow.sale?.txnId] as const,
	([status, id]) => {
		if (id && status === "posted" && !issued.value.length) issued.value = takeIssuedCards(id);
	},
	{ immediate: true },
);
const redeemed = computed<{ masked_code: string; balance_after: number; amount: number }[]>(() => {
	try {
		return flow.sale?.serverJson ? (JSON.parse(flow.sale.serverJson).gift_cards ?? []) : [];
	} catch {
		return [];
	}
});

const evidence = computed<SaleEvidence | null>(() => (flow.sale ? JSON.parse(flow.sale.evidenceJson) : null));
const open = computed(() => flow.step !== "idle");
const problem = computed(
	() => flow.sale && ["rejected", "uncertain", "held", "fiscal_pending"].includes(flow.sale.status),
);
</script>

<template>
	<div
		v-if="open"
		class="fixed inset-0 z-30 flex flex-col justify-end bg-[hsl(var(--scrim)/0.5)] md:items-center md:justify-center"
		@keydown.esc="cancel"
	>
		<div
			class="relative flex max-h-[92%] w-full flex-col overflow-hidden rounded-t-2xl border border-border bg-card shadow-overlay md:max-w-lg md:rounded-2xl"
			role="dialog"
			aria-modal="true"
			aria-label="Payment"
		>
			<header class="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-3">
				<h2 class="text-lg font-bold">
					{{ flow.step === "done" ? "Sale" : flow.reprice ? "Prices changed" : "Take payment" }}
				</h2>
				<Button
					v-if="flow.step !== 'sending'"
					variant="ghost"
					size="icon"
					class="size-11"
					aria-label="Close"
					@click="flow.step === 'done' ? finish() : cancel()"
					><X
				/></Button>
			</header>

			<div v-if="flow.step === 'quoting'" class="px-4 py-10 text-center" role="status">
				<p class="font-semibold">Asking ERPNext for prices and taxes…</p>
			</div>

			<div v-else-if="flow.step === 'sending'" class="px-4 py-10 text-center" role="status">
				<p class="font-semibold">Saving the sale and sending it to ERPNext…</p>
				<p class="mt-1 text-xs text-muted-foreground">The sale is already stored on this device.</p>
			</div>

			<div
				v-else-if="flow.step === 'paying'"
				class="xpos-scrollbar min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3"
			>
				<div
					v-if="flow.reprice"
					class="rounded-xl border border-warning/30 bg-warning-soft px-3 py-2 text-sm text-warning-soft-foreground"
					role="status"
				>
					<p class="font-semibold">{{ flow.reprice.message }}</p>
					<ul class="mt-1 text-xs tabular-nums">
						<li v-for="l in flow.reprice.lines" :key="l.rowId">
							Line {{ Number(l.rowId) + 1 }}: {{ l.quotedRate }} → {{ l.rate ?? "no price" }}
						</li>
					</ul>
				</div>
				<dl
					v-if="flow.quote && !flow.reprice"
					class="grid grid-cols-[1fr_auto] gap-x-4 gap-y-0.5 text-sm tabular-nums"
				>
					<dt class="text-muted-foreground">Customer</dt>
					<dd class="truncate">{{ customerName }}</dd>
					<dt class="text-muted-foreground">Items</dt>
					<dd>{{ money(flow.quote.netMinor) }}</dd>
					<template v-if="flow.quote.discountMinor">
						<dt class="text-muted-foreground">Discount</dt>
						<dd>-{{ money(flow.quote.discountMinor) }}</dd>
					</template>
					<template v-if="flow.quote.taxMinor">
						<dt class="text-muted-foreground">Taxes</dt>
						<dd>{{ money(flow.quote.taxMinor) }}</dd>
					</template>
					<template v-if="flow.quote.loyaltyMinor">
						<dt class="text-muted-foreground">Loyalty points</dt>
						<dd>-{{ money(flow.quote.loyaltyMinor) }}</dd>
					</template>
				</dl>
				<div class="flex items-baseline justify-between">
					<span class="text-lg font-bold">Amount due</span>
					<span class="text-2xl font-extrabold tracking-tight tabular-nums"
						>{{ currency }} {{ money(due) }}</span
					>
				</div>

				<ul class="space-y-2" aria-label="Payments">
					<li
						v-for="(r, i) in rows"
						:key="i"
						class="rounded-xl border border-border bg-surface-raised p-2.5 shadow-raised"
					>
						<div v-if="r.giftAuth" class="flex items-center gap-2">
							<Gift class="size-5 shrink-0 text-primary" aria-hidden="true" />
							<div class="min-w-0 flex-1">
								<p class="truncate text-sm font-semibold">Gift card {{ r.masked }}</p>
								<p class="text-xs text-muted-foreground tabular-nums">
									Balance {{ money(r.balanceMinor ?? 0) }}
								</p>
							</div>
							<Input
								v-model="r.amount"
								inputmode="decimal"
								class="h-11 w-28 text-end text-base tabular-nums"
								:aria-label="`Amount ${i + 1}`"
							/>
							<Button
								variant="ghost"
								size="icon"
								class="size-11"
								aria-label="Remove gift card"
								@click="rows.splice(i, 1)"
								><Trash2
							/></Button>
						</div>
						<div v-else class="flex items-center gap-2">
							<component
								:is="typeOf(r.mode) === 'Cash' ? Banknote : CreditCard"
								class="size-5 shrink-0 text-primary"
								aria-hidden="true"
							/>
							<select
								v-model="r.mode"
								class="h-11 min-w-0 flex-1 rounded-lg border border-input bg-background px-2 text-base shadow-inset"
								:aria-label="`Payment method ${i + 1}`"
							>
								<option
									v-for="m in modes"
									:key="m.mode_of_payment"
									:value="m.mode_of_payment"
								>
									{{ m.mode_of_payment }}
								</option>
							</select>
							<Input
								v-model="r.amount"
								inputmode="decimal"
								class="h-11 w-28 text-end text-base tabular-nums"
								:aria-label="`Amount ${i + 1}`"
							/>
							<Button
								v-if="rows.length > 1"
								variant="ghost"
								size="icon"
								class="size-11"
								aria-label="Remove payment"
								@click="rows.splice(i, 1)"
								><Trash2
							/></Button>
						</div>
						<div v-if="!r.giftAuth && typeOf(r.mode) !== 'Cash'" class="mt-2 space-y-2">
							<Input
								v-model="r.reference"
								class="h-11 text-base"
								:placeholder="
									modes.find((m) => m.mode_of_payment === r.mode)?.requires_reference
										? 'Reference (required)'
										: 'Terminal / transfer reference'
								"
								:aria-label="`Reference ${i + 1}`"
							/>
							<label class="flex min-h-11 items-center gap-2 text-sm">
								<input v-model="r.confirmed" type="checkbox" class="size-5" />
								Cashier-confirmed: I saw this payment approved. XPOS does not check it with
								the terminal or bank.
							</label>
						</div>
					</li>
				</ul>
				<Button v-if="modes.length > 1" variant="outline" class="h-11" @click="addRow"
					><Plus /> Add payment</Button
				>
				<form v-if="canRedeem" class="space-y-2" @submit.prevent="addGiftCard">
					<label class="text-sm font-medium" for="gift-code">Pay with a gift card</label>
					<div class="flex gap-2">
						<Input
							id="gift-code"
							v-model="giftCode"
							class="h-11 text-base"
							autocomplete="off"
							autocapitalize="characters"
							placeholder="Gift card code"
						/>
						<Button
							type="submit"
							variant="outline"
							class="h-11"
							:loading="giftBusy"
							:disabled="!giftCode.trim()"
							>Check</Button
						>
					</div>
				</form>

				<p v-if="check.ok && check.changeMinor > 0" class="text-sm font-semibold tabular-nums">
					Change: {{ currency }} {{ money(check.changeMinor) }}
				</p>
				<p v-else-if="!check.ok" class="text-xs text-muted-foreground" role="status">
					{{ check.reason }}
				</p>
			</div>

			<div
				v-else-if="flow.step === 'done' && flow.sale"
				class="xpos-scrollbar min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3"
			>
				<div class="flex items-center gap-2">
					<Badge
						:variant="
							flow.sale.status === 'posted' ? 'success' : problem ? 'destructive' : 'warning'
						"
						dot
						>{{ flow.sale.status.replace("_", " ") }}</Badge
					>
					<span class="text-sm font-semibold">{{ flow.sale.invoice ?? flow.sale.txnId }}</span>
				</div>
				<p class="text-sm" :class="problem ? 'text-destructive-soft-foreground' : ''" role="status">
					{{ describeSale(flow.sale) }}
				</p>
				<template v-if="evidence">
					<ul class="divide-y divide-border rounded-xl border border-border text-sm">
						<li
							v-for="l in evidence.lines"
							:key="l.itemCode"
							class="flex justify-between gap-2 px-3 py-1.5 tabular-nums"
						>
							<span class="min-w-0 truncate">{{ l.qtyMilli / 1000 }} x {{ l.name }}</span
							><span>{{ money(l.totalMinor) }}</span>
						</li>
					</ul>
					<dl class="text-sm tabular-nums">
						<div class="flex justify-between">
							<dt>Amount due{{ flow.sale.status === "posted" ? "" : " (estimate)" }}</dt>
							<dd class="font-bold">{{ currency }} {{ money(flow.sale.payableMinor) }}</dd>
						</div>
						<div
							v-for="t in evidence.tenders"
							:key="t.mode"
							class="flex justify-between text-muted-foreground"
						>
							<dt>
								{{ t.mode }}{{ t.reference ? ` · ${t.reference}` : ""
								}}{{ t.terminalConfirmed ? " (cashier-confirmed)" : "" }}
							</dt>
							<dd>{{ money(t.amountMinor) }}</dd>
						</div>
						<div v-if="evidence.changeMinor" class="flex justify-between">
							<dt>Change</dt>
							<dd>{{ money(evidence.changeMinor) }}</dd>
						</div>
					</dl>
				</template>
				<p class="text-xs text-muted-foreground">
					Card and transfer payments are recorded as entered by the cashier; the app does not verify
					them. Not printed: printing is not available yet.
				</p>
			</div>

			<footer class="flex shrink-0 gap-2 border-t border-border px-4 py-3">
				<template v-if="flow.step === 'paying'">
					<Button variant="outline" class="h-12 flex-1" @click="cancel">Back</Button>
					<Button class="h-12 flex-2 text-base font-semibold" :disabled="!check.ok" @click="submit"
						>Take payment</Button
					>
				</template>
				<Button
					v-else-if="flow.step === 'done' && flow.reprice"
					class="h-12 w-full text-base font-semibold"
					@click="flow.step = 'paying'"
					>Review new prices and re-take payment</Button
				>
				<Button
					v-else-if="flow.step === 'done'"
					class="h-12 w-full text-base font-semibold"
					@click="finish"
					>{{ problem ? "Close (the sale stays saved)" : "New sale" }}</Button
				>
			</footer>
		</div>
	</div>
</template>
