import { computed } from "vue";
import { customerForSale, type CustomerDetail, type CustomerSummary } from "@mobile/app/customers";
import { getContainer, useApp } from "./useApp";
import { resetPricingChoices } from "./useCart";
import { resetSaleCustomer, saleCustomer } from "./saleCustomer";
import { toast } from "./useToast";

/**
 * The customer on the sale: the one picked, else the POS Profile's default customer.
 * Changing it clears everything the previous customer's context decided (coupons, loyalty points, set prices and
 * discounts), and the live quote then prices the cart again for the new customer.
 */
export function useCustomer() {
	const { state } = useApp();
	const name = computed(() => saleCustomer.customer?.name ?? state.context.customer ?? "");
	const displayName = computed(
		() => saleCustomer.customer?.customerName ?? state.context.customerName ?? name.value,
	);
	const isDefault = computed(
		() => !saleCustomer.customer || saleCustomer.customer.name === state.context.customer,
	);

	async function load(customer: string): Promise<CustomerDetail> {
		const e = state.cashier!;
		const api = await getContainer().session(e.site);
		return customerForSale(api, e.profile, customer, e.minorDigits);
	}

	/** Picks a customer from a search result; resolves with the detail the server returned. */
	async function choose(pick: CustomerSummary | CustomerDetail): Promise<void> {
		if (pick.name === name.value) return;
		const detail = "balanceMinor" in pick ? pick : await load(pick.name);
		const cleared = resetPricingChoices();
		saleCustomer.customer = detail;
		if (cleared)
			toast.info("Coupons, loyalty points and manual discounts were cleared for the new customer.");
	}

	async function useDefault(): Promise<void> {
		if (isDefault.value) return;
		const cleared = resetPricingChoices();
		resetSaleCustomer();
		if (cleared) toast.info("Coupons, loyalty points and manual discounts were cleared.");
	}

	return { customer: saleCustomer, name, displayName, isDefault, choose, useDefault, load };
}
