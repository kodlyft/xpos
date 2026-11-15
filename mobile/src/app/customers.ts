/**
 * Customers for the sale, always asked of the server one search at a time: the server applies the POS Profile's
 * customer groups and this user's User Permissions, so the phone never holds a customer list it was not shown.
 */
import type { ApiTransport } from "@mobile/ports";
import { fromRate } from "@mobile/domain/money";

export interface CustomerSummary {
	name: string;
	customerName: string;
	mobileNo: string | null;
	customerGroup: string;
	/** The customer's own discount in percent, applied only where the POS Profile applies customer discounts. */
	discountPct: number;
	/** The price list this customer's sale lines are priced from on this profile. */
	priceList: string | null;
}

export interface CustomerDetail extends CustomerSummary {
	emailId: string | null;
	balanceMinor: number;
	creditLimitMinor: number;
	loyaltyPoints: number;
	loyaltyProgram: string | null;
}

interface SummaryReply {
	name: string;
	customer_name: string;
	mobile_no?: string | null;
	customer_group: string;
	discount?: number;
	price_list?: string | null;
}

interface DetailReply extends SummaryReply {
	email_id?: string | null;
	balance?: number;
	credit_limit?: number;
	loyalty_points?: number;
	loyalty_program?: { name?: string } | null;
}

const summary = (r: SummaryReply): CustomerSummary => ({
	name: r.name,
	customerName: r.customer_name,
	mobileNo: r.mobile_no ?? null,
	customerGroup: r.customer_group,
	discountPct: Number(r.discount ?? 0),
	priceList: r.price_list ?? null,
});

export async function searchCustomers(
	api: ApiTransport,
	profile: string,
	term: string,
	limit = 20,
): Promise<CustomerSummary[]> {
	const rows = await api.call<SummaryReply[]>("xpos.api.customers.search_customers_mobile", {
		pos_profile: profile,
		term: term.trim(),
		limit,
	});
	return rows.map(summary);
}

export async function customerForSale(
	api: ApiTransport,
	profile: string,
	customer: string,
	minorDigits: number,
): Promise<CustomerDetail> {
	const r = await api.call<DetailReply>("xpos.api.customers.get_customer_for_sale", {
		pos_profile: profile,
		customer,
	});
	return {
		...summary(r),
		emailId: r.email_id ?? null,
		balanceMinor: Math.round(Number(r.balance ?? 0) * 10 ** minorDigits),
		creditLimitMinor: fromRate(Number(r.credit_limit ?? 0), minorDigits),
		loyaltyPoints: Number(r.loyalty_points ?? 0),
		loyaltyProgram: r.loyalty_program?.name ?? null,
	};
}

export interface NewCustomer {
	customerName: string;
	mobileNo: string;
	emailId: string;
	customerGroup: string;
}

export async function createCustomer(
	api: ApiTransport,
	profile: string,
	input: NewCustomer,
	minorDigits: number,
): Promise<CustomerDetail> {
	const made = await api.call<DetailReply>("xpos.api.customers.create_customer_mobile", {
		pos_profile: profile,
		customer_name: input.customerName,
		mobile_no: input.mobileNo,
		email_id: input.emailId,
		customer_group: input.customerGroup || null,
	});
	return customerForSale(api, profile, made.name, minorDigits);
}

export async function updateCustomer(
	api: ApiTransport,
	profile: string,
	customer: string,
	patch: { customerName?: string; mobileNo?: string; emailId?: string },
	minorDigits: number,
): Promise<CustomerDetail> {
	await api.call("xpos.api.customers.update_customer_mobile", {
		pos_profile: profile,
		customer,
		data: {
			...(patch.customerName !== undefined ? { customer_name: patch.customerName } : {}),
			...(patch.mobileNo !== undefined ? { mobile_no: patch.mobileNo } : {}),
			...(patch.emailId !== undefined ? { email_id: patch.emailId } : {}),
		},
	});
	return customerForSale(api, profile, customer, minorDigits);
}
