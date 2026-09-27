import { useCacheStatus } from "./cacheStatus";
import { defineStore } from "pinia";
import { ref, computed, type ComputedRef } from "vue";
import { call } from "@/services/api";
import { usePosStore } from "@/stores/posStore";
import { cacheCustomers, getCachedCustomers, searchCachedCustomers } from "@/services/dbBridge";
import type {
	Customer,
	CustomerAddress,
	CustomerCredit,
	LoyaltyProgram,
	CustomerLoyaltyInfo,
} from "@/types/pos.types";
import { isOnline } from "@/utils";

export const useCustomerStore = defineStore("customers", () => {
	const customers = ref<Customer[]>([]);
	const isLoading = ref(false);
	const searchTerm = ref("");
	const showCustomerDialog = ref(false);
	const showNewCustomerForm = ref(false);
	const showLoyaltyDialog = ref(false);
	const showCustomerEditDialog = ref(false);

	const selectedCustomerInfo = ref<Customer | null>(null);
	const customerAddresses = ref<CustomerAddress[]>([]);
	const customerCredit = ref<CustomerCredit | null>(null);
	const isLoadingDetail = ref(false);

	const loyaltyPrograms = ref<LoyaltyProgram[]>([]);
	const customerLoyaltyInfo = ref<CustomerLoyaltyInfo | null>(null);
	const isLoadingLoyalty = ref(false);

	const filteredCustomers = computed(() => customers.value);

	const hasCredit = computed(() => (customerCredit.value?.total_credit || 0) > 0);

	async function searchCustomers(term = "", posProfile?: string): Promise<void> {
		if (isLoading.value) return;
		isLoading.value = true;

		try {
			const searchText = term || searchTerm.value;

			if (!isOnline() && usePosStore().useOfflineMode) {
				const cached = await searchCachedCustomers(searchText);
				customers.value = cached;
				return;
			}

			if (isOnline()) {
				const result = await call<Customer[]>("xpos.api.customers.get_customers", {
					search_term: searchText,
					pos_profile: posProfile || "",
					limit: 100,
				});
				customers.value = result || [];
			}
		} catch (error) {
			console.error("Error searching customers:", error);

			if (usePosStore().useOfflineMode) {
				try {
					const cached = await searchCachedCustomers(term || searchTerm.value);
					if (cached.length > 0) {
						customers.value = cached;
						return;
					}
				} catch (cacheError) {
					console.warn("[XPOS Offline] Failed to load cached customers:", cacheError);
				}
			}
			customers.value = [];
		} finally {
			isLoading.value = false;
		}
	}

	async function cacheAllCustomers(posProfile?: string): Promise<void> {
		if (!isOnline()) return;
		const status = useCacheStatus();
		if (!status.begin("Customers", posProfile || "")) return;
		try {
			const result = await call<{ customers: Customer[]; complete: boolean }>("xpos.api.customers.get_customers", {
				search_term: "",
				pos_profile: posProfile || "",
				preload: 1,
				with_metadata: 1,
			});

			if (result) {
				await cacheCustomers(result.customers.map((customer, rank) => ({ ...customer, xpos_cache_rank: rank })));
				status.finish("Customers", posProfile || "", result.customers.length, result.complete);
			}
		} catch (error) {
			status.fail("Customers");
			console.warn("[XPOS Offline] Failed to pre-cache customers:", error);
		}
	}

	async function createCustomer(data: Record<string, unknown>): Promise<Customer> {
		try {
			const result = await call<Customer>("xpos.api.customers.create_customer", data);
			showNewCustomerForm.value = false;

			if (result && result.name) {
				const exists = customers.value.some((c) => c.name === result.name);
				if (!exists) {
					customers.value.unshift(result);
				}
			}

			return result;
		} catch (error) {
			console.error("Error creating customer:", error);
			throw error;
		}
	}

	async function updateCustomer(customerName: string, data: Record<string, unknown>): Promise<Customer> {
		try {
			const result = await call<Customer>("xpos.api.customers.update_customer", {
				customer: customerName,
				data: JSON.stringify(data),
			});
			return result;
		} catch (error) {
			console.error("Error updating customer:", error);
			throw error;
		}
	}

	async function getCustomerInfo(customerName: string): Promise<Customer | null> {
		isLoadingDetail.value = true;
		try {
			if (!isOnline() && usePosStore().useOfflineMode) {
				const cached = await getCachedCustomers();
				const customer = cached.find(
					(c) => c.name === customerName || c.customer_name === customerName,
				);
				selectedCustomerInfo.value = customer || null;
				return selectedCustomerInfo.value;
			}

			if (isOnline()) {
				const result = await call<Customer>("xpos.api.customers.get_customer_info", {
					customer: customerName,
				});
				selectedCustomerInfo.value = result;
				return result;
			}

			return null;
		} catch (error) {
			console.error("Error fetching customer info:", error);
			return null;
		} finally {
			isLoadingDetail.value = false;
		}
	}

	async function fetchAddresses(customerName: string): Promise<CustomerAddress[]> {
		try {
			const result = await call<CustomerAddress[]>("xpos.api.customers.get_customer_addresses", {
				customer: customerName,
			});
			customerAddresses.value = result || [];
			return customerAddresses.value;
		} catch (error) {
			console.error("Error fetching addresses:", error);
			return [];
		}
	}

	async function createAddress(data: Record<string, unknown>): Promise<CustomerAddress> {
		try {
			const result = await call<CustomerAddress>("xpos.api.customers.make_address", data);
			return result;
		} catch (error) {
			console.error("Error creating address:", error);
			throw error;
		}
	}

	async function fetchCredit(customerName: string, company?: string): Promise<CustomerCredit | null> {
		try {
			const result = await call<CustomerCredit>("xpos.api.customers.get_customer_credit", {
				customer: customerName,
				company: company || "",
			});
			customerCredit.value = result;
			return result;
		} catch (error) {
			console.error("Error fetching credit:", error);
			return null;
		}
	}

	function clearDetail(): void {
		selectedCustomerInfo.value = null;
		customerAddresses.value = [];
		customerCredit.value = null;
	}

	async function fetchLoyaltyPrograms(company?: string): Promise<LoyaltyProgram[]> {
		try {
			const result = await call<LoyaltyProgram[]>("xpos.api.customers.get_loyalty_programs", {
				company: company || "",
			});
			loyaltyPrograms.value = result || [];
			return loyaltyPrograms.value;
		} catch (error) {
			console.error("Error fetching loyalty programs:", error);
			return [];
		}
	}

	async function fetchCustomerLoyaltyInfo(customerName: string): Promise<CustomerLoyaltyInfo | null> {
		isLoadingLoyalty.value = true;
		try {
			const result = await call<CustomerLoyaltyInfo>("xpos.api.customers.get_customer_loyalty_info", {
				customer: customerName,
			});
			customerLoyaltyInfo.value = result;
			return result;
		} catch (error) {
			console.error("Error fetching customer loyalty info:", error);
			return null;
		} finally {
			isLoadingLoyalty.value = false;
		}
	}

	async function registerCustomerLoyalty(
		customerName: string,
		loyaltyProgram: string,
	): Promise<{ success: boolean; message?: string; data?: unknown }> {
		try {
			const result = await call<{ message: string }>("xpos.api.customers.register_customer_loyalty", {
				customer: customerName,
				loyalty_program: loyaltyProgram,
			});

			await fetchCustomerLoyaltyInfo(customerName);
			return { success: true, message: result?.message, data: result };
		} catch (error) {
			console.error("Error registering customer loyalty:", error);
			const err = error as Record<string, unknown>;
			let message = "Failed to register for loyalty program";
			if (err._server_messages) {
				try {
					const msgs = JSON.parse(err._server_messages as string);
					const parsed = typeof msgs === "string" ? [msgs] : msgs;
					message = parsed
						.map((m: string) => {
							try {
								return JSON.parse(m).message || m;
							} catch {
								return m;
							}
						})
						.join(", ");
				} catch {
					/* ignore */
				}
			} else if (err.message) {
				message = err.message as string;
			}
			return { success: false, message };
		}
	}

	async function unenrollCustomerLoyalty(
		customerName: string,
	): Promise<{ success: boolean; message?: string }> {
		try {
			const result = await call<{ message: string }>("xpos.api.customers.unenroll_customer_loyalty", {
				customer: customerName,
			});

			customerLoyaltyInfo.value = null;
			return { success: true, message: result?.message };
		} catch (error) {
			console.error("Error unenrolling customer loyalty:", error);
			return { success: false, message: "Failed to unenroll from loyalty program" };
		}
	}

	function clearLoyaltyInfo(): void {
		customerLoyaltyInfo.value = null;
		loyaltyPrograms.value = [];
	}

	return {
		// State
		customers,
		isLoading,
		searchTerm,
		showCustomerDialog,
		showNewCustomerForm,
		showLoyaltyDialog,
		showCustomerEditDialog,
		selectedCustomerInfo,
		customerAddresses,
		customerCredit,
		isLoadingDetail,
		loyaltyPrograms,
		customerLoyaltyInfo,
		isLoadingLoyalty,
		// Computed
		filteredCustomers,
		hasCredit,
		// Actions
		searchCustomers,
		cacheAllCustomers,
		createCustomer,
		updateCustomer,
		getCustomerInfo,
		fetchAddresses,
		createAddress,
		fetchCredit,
		clearDetail,
		fetchLoyaltyPrograms,
		fetchCustomerLoyaltyInfo,
		registerCustomerLoyalty,
		unenrollCustomerLoyalty,
		clearLoyaltyInfo,
	};
});
