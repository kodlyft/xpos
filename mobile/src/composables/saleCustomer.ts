import { reactive } from "vue";
import type { CustomerDetail } from "@mobile/app/customers";

/**
 * The customer chosen for the sale in progress. Null means the POS Profile's default (walk-in) customer. It lives apart
 * from useApp so the session code can clear it on sign-out without importing the customer screens.
 */
export const saleCustomer = reactive({ customer: null as CustomerDetail | null });

export function resetSaleCustomer(): void {
	saleCustomer.customer = null;
}
