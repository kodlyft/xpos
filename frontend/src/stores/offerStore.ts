import { defineStore } from "pinia";
import { ref, type Ref } from "vue";
import { call, isNetworkError } from "@/services/api";
import { cacheOffers, getCachedOffers } from "@/services/dbBridge";
import type { POSOffer, POSCoupon, GiftCoupon, DeliveryCharge } from "@/types/pos.types";
import __ from "@/lib/translate";

function couponErrorMessage(error: unknown): string {
	if (isNetworkError(error)) return __("Could not reach the server to validate the coupon");
	if (error instanceof Error && error.name === "Error" && error.message) return error.message;
	return __("Failed to validate coupon");
}

export const useOfferStore = defineStore("offers", () => {
	const offers = ref<POSOffer[]>([]);
	const isLoading = ref(false);

	const coupon = ref<POSCoupon | null>(null);
	const isLoadingCoupon = ref(false);

	const giftCoupons = ref<GiftCoupon[]>([]);

	const deliveryCharges = ref<DeliveryCharge[]>([]);

	async function fetchOffers(
		posProfile: string,
		itemCodes?: string[],
		customer?: string,
	): Promise<POSOffer[]> {
		isLoading.value = true;
		try {
			const result = await call<POSOffer[]>("xpos.api.offers.get_offers", {
				pos_profile: posProfile,
				item_codes: JSON.stringify(itemCodes || []),
				customer: customer || "",
			});
			offers.value = result || [];
			if (offers.value.length > 0) {
				cacheOffers(posProfile, offers.value).catch(() => {});
			}
			return offers.value;
		} catch (error) {
			if (isNetworkError(error)) {
				try {
					const cached = await getCachedOffers(posProfile);
					if (cached && cached.length > 0) {
						offers.value = cached as POSOffer[];
						return offers.value;
					}
				} catch {
					/* ignore */
				}
			}
			console.error("Error fetching offers:", error);
			return [];
		} finally {
			isLoading.value = false;
		}
	}

	async function fetchCoupon(
		couponCode: string,
		customer?: string,
		company?: string,
	): Promise<{ coupon: POSCoupon | null; offer?: Record<string, unknown> | null; msg?: string }> {
		isLoadingCoupon.value = true;
		try {
			const result = await call<{
				coupon: POSCoupon | null;
				offer?: Record<string, unknown> | null;
				msg?: string;
			}>("xpos.api.offers.get_pos_coupon", {
				coupon: couponCode,
				customer: customer || "",
				company: company || "",
			});
			coupon.value = result?.coupon ?? null;
			return result || { coupon: null };
		} catch (error) {
			console.error("Error fetching coupon:", error);
			coupon.value = null;
			return { coupon: null, msg: couponErrorMessage(error) };
		} finally {
			isLoadingCoupon.value = false;
		}
	}

	async function fetchGiftCoupons(customer?: string): Promise<GiftCoupon[]> {
		try {
			const result = await call<GiftCoupon[]>("xpos.api.offers.get_active_gift_coupons", {
				customer: customer || "",
			});
			giftCoupons.value = result || [];
			return giftCoupons.value;
		} catch (error) {
			console.error("Error fetching gift coupons:", error);
			return [];
		}
	}

	async function fetchDeliveryCharges(
		posProfile: string,
		company: string,
		customer?: string,
	): Promise<DeliveryCharge[]> {
		try {
			const result = await call<DeliveryCharge[]>("xpos.api.offers.get_applicable_delivery_charges", {
				pos_profile: posProfile,
				company: company,
				customer: customer || "",
			});
			deliveryCharges.value = result || [];
			return deliveryCharges.value;
		} catch (error) {
			console.error("Error fetching delivery charges:", error);
			return [];
		}
	}

	function clearOffers(): void {
		offers.value = [];
		coupon.value = null;
		giftCoupons.value = [];
		deliveryCharges.value = [];
	}

	return {
		offers,
		isLoading,
		coupon,
		isLoadingCoupon,
		giftCoupons,
		deliveryCharges,
		fetchOffers,
		fetchCoupon,
		fetchGiftCoupons,
		fetchDeliveryCharges,
		clearOffers,
	};
});
