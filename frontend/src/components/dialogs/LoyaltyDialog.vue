<template>
	<Dialog
		:open="customerStore.showLoyaltyDialog"
		@update:open="
			(val: boolean) => {
				if (!val) close();
			}
		"
	>
		<DialogContent class="max-w-md max-h-[80vh] flex flex-col p-0 gap-0">
			<DialogHeader class="shrink-0 px-5 pt-5 pb-3 border-b border-border">
				<div class="flex items-center gap-2">
					<Gift class="w-5 h-5 text-primary" />
					<DialogTitle>{{ __("Loyalty Program") }}</DialogTitle>
				</div>
				<DialogDescription v-if="customerName" class="text-xs">
					{{ __("Manage loyalty for") }} {{ customerName }}
				</DialogDescription>
			</DialogHeader>

			<div class="flex-1 overflow-y-auto p-5 space-y-4 xpos-scrollbar">
				<div v-if="isLoading" class="flex items-center justify-center py-8">
					<Loader2 class="w-8 h-8 text-primary animate-spin" />
				</div>

				<template v-else>
					<div
						v-if="customerStore.customerLoyaltyInfo?.enrolled"
						class="bg-primary/5 border border-primary/30 rounded-xl p-4 space-y-3"
					>
						<div class="flex items-center justify-between">
							<div class="flex items-center gap-2">
								<Award class="w-5 h-5 text-primary" />
								<span class="font-semibold text-foreground">{{ __("Enrolled") }}</span>
							</div>
							<Badge variant="secondary" class="bg-primary/10 text-primary">
								{{
									customerStore.customerLoyaltyInfo.loyalty_program_name ||
									customerStore.customerLoyaltyInfo.loyalty_program
								}}
							</Badge>
						</div>

						<div class="grid grid-cols-2 gap-3 text-sm">
							<div class="bg-background rounded-lg p-2.5 text-center">
								<p class="text-2xl font-bold text-primary">
									{{ customerStore.customerLoyaltyInfo.loyalty_points || 0 }}
								</p>
								<p class="text-[11px] text-muted-foreground">
									{{ __("Points Balance") }}
								</p>
							</div>
							<div class="bg-background rounded-lg p-2.5 text-center">
								<p class="text-2xl font-bold text-success">
									{{ money(customerStore.customerLoyaltyInfo.points_value || 0) }}
								</p>
								<p class="text-[11px] text-muted-foreground">
									{{ __("Points Value") }}
								</p>
							</div>
						</div>

						<div v-if="customerStore.customerLoyaltyInfo.current_tier" class="text-sm">
							<span class="text-muted-foreground">{{ __("Current Tier") }}:</span>
							<Badge variant="outline" class="ms-2">
								{{ customerStore.customerLoyaltyInfo.current_tier }}
							</Badge>
						</div>

						<Button
							variant="outline"
							class="w-full text-destructive border-destructive/30 hover:bg-destructive/10"
							@click="handleUnenroll"
							:disabled="isProcessing"
						>
							<UserMinus class="w-4 h-4" />
							{{ isProcessing ? __("Processing...") : __("Unenroll from Program") }}
						</Button>
					</div>

					<template v-else>
						<div class="text-center py-4">
							<Gift class="w-12 h-12 mx-auto text-muted-foreground/40 mb-3" />
							<p class="text-sm font-medium text-foreground">
								{{ __("Not Enrolled") }}
							</p>
							<p class="text-xs text-muted-foreground mt-1">
								{{ __("Select a loyalty program to enroll this customer") }}
							</p>
						</div>

						<div v-if="customerStore.loyaltyPrograms.length > 0" class="space-y-2">
							<h3 class="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
								{{ __("Available Programs") }}
							</h3>
							<div class="space-y-2">
								<button
									v-for="program in customerStore.loyaltyPrograms"
									:key="program.name"
									@click="selectedProgram = program.name"
									class="w-full p-3 rounded-xl border-2 text-start transition-all duration-150"
									:class="
										selectedProgram === program.name
											? 'border-primary/30 bg-primary/5'
											: 'border-border hover:border-primary/30'
									"
								>
									<div class="flex items-center justify-between mb-1">
										<span class="font-semibold text-foreground">
											{{ program.loyalty_program_name || program.name }}
										</span>
										<Badge
											v-if="selectedProgram === program.name"
											variant="default"
											class="bg-primary"
										>
											{{ __("Selected") }}
										</Badge>
									</div>
									<div class="flex items-center gap-3 text-xs text-muted-foreground">
										<span>
											{{ program.conversion_factor }} pts =
											{{ posStore.currencySymbol }} 1</span
										>
										<span v-if="program.expiry_duration">
											{{ __("Expires") }}: {{ program.expiry_duration }}
											{{ __("days") }}
										</span>
									</div>

									<div
										v-if="program.tiers && program.tiers.length > 0"
										class="mt-2 flex flex-wrap gap-1"
									>
										<Badge
											v-for="tier in program.tiers.slice(0, 3)"
											:key="tier.tier_name"
											variant="outline"
											class="text-[10px]"
										>
											{{ tier.tier_name }}
										</Badge>
										<div class="flex items-center gap-3 text-xs text-muted-foreground">
											<span v-for="tier in program.tiers.slice(0, 3)">
												{{ __("Collection factor") }}:
												{{ tier.collection_factor }}
											</span>
										</div>
										<Badge
											v-if="program.tiers.length > 3"
											variant="outline"
											class="text-[10px]"
										>
											+{{ program.tiers.length - 3 }} {{ __("more") }}
										</Badge>
									</div>
								</button>
							</div>
						</div>

						<div v-else class="text-center py-4 text-muted-foreground">
							<p class="text-sm">{{ __("No loyalty programs available") }}</p>
							<p class="text-xs mt-1">
								{{ __("Contact administrator to set up loyalty programs") }}
							</p>
						</div>
					</template>
				</template>
			</div>

			<DialogFooter class="shrink-0 border-t border-border px-5 py-4">
				<Button variant="default" class="flex-1" @click="close">
					{{ __("Close") }}
				</Button>
				<Button
					v-if="!customerStore.customerLoyaltyInfo?.enrolled && selectedProgram"
					class="flex-1 bg-primary hover:bg-primary/90 text-primary-foreground"
					:disabled="isProcessing"
					@click="handleEnroll"
				>
					<UserPlus class="w-4 h-4" />
					{{ isProcessing ? __("Enrolling...") : __("Enroll Customer") }}
				</Button>
			</DialogFooter>
		</DialogContent>
	</Dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { useCustomerStore } from "@/stores/customerStore";
import { useCartStore } from "@/stores/cartStore";
import { usePosStore } from "@/stores/posStore";
import { useMoney } from "@/composables/useMoney";
import { showSuccess, showError } from "@/services/api";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Gift, Award, Loader2, UserPlus, UserMinus } from "lucide-vue-next";
import __ from "@/lib/translate";
import { storeToRefs } from "pinia";

const customerStore = useCustomerStore();
const { showLoyaltyDialog } = storeToRefs(customerStore);
const cartStore = useCartStore();
const posStore = usePosStore();
const { money } = useMoney();

const selectedProgram = ref("");
const isProcessing = ref(false);

const isLoading = computed(() => customerStore.isLoadingLoyalty);

const customerName = computed(() => {
	if (cartStore.customer?.customer_name) return cartStore.customer.customer_name;
	if (cartStore.customer?.name) return cartStore.customer.name;
	return "";
});

watch(
	showLoyaltyDialog,
	async (open) => {
		if (open && cartStore.customer?.name) {
			selectedProgram.value = "";
			await Promise.all([
				customerStore.fetchCustomerLoyaltyInfo(cartStore.customer.name),
				customerStore.fetchLoyaltyPrograms(posStore.companyName),
			]);
		}
	},
	{ immediate: true },
);

async function handleEnroll() {
	if (!selectedProgram.value || !cartStore.customer?.name) return;

	isProcessing.value = true;
	try {
		const result = await customerStore.registerCustomerLoyalty(
			cartStore.customer.name,
			selectedProgram.value,
		);
		if (result.success) {
			showSuccess(result.message || __("Customer enrolled successfully"));
			selectedProgram.value = "";
		} else {
			showError(result.message || __("Failed to enroll customer"));
		}
	} finally {
		isProcessing.value = false;
	}
}

async function handleUnenroll() {
	if (!cartStore.customer?.name) return;

	isProcessing.value = true;
	try {
		const result = await customerStore.unenrollCustomerLoyalty(cartStore.customer.name);
		if (result.success) {
			showSuccess(result.message || __("Customer unenrolled successfully"));
		} else {
			showError(result.message || __("Failed to unenroll customer"));
		}
	} finally {
		isProcessing.value = false;
	}
}

function close() {
	customerStore.showLoyaltyDialog = false;
	selectedProgram.value = "";
	customerStore.clearLoyaltyInfo();
}
</script>
