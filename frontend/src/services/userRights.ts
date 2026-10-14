import { ref, computed } from "vue";
import { isElectron } from "./electronBridge";
import { call } from "./api";

export interface PosPermissions {
	close_shift: boolean;
	allow_reprint_invoice: boolean;
	print_draft_invoice: boolean;
	shift_report: boolean;
	apply_additional_discount: boolean;
	show_edit_discount_field: boolean;
	allow_change_price: boolean;
	sale_return: boolean;
	recall_other_shift_tabs: boolean;
	settle_outstanding_invoice: boolean;
	sell_gift_card: boolean;
	redeem_gift_card: boolean;
	expense: boolean;
	bank_drop: boolean;
	current_stock_by_brand: boolean;
	current_stock_report: boolean;
}

const DEFAULT_PERMISSIONS: PosPermissions = {
	close_shift: false,
	allow_reprint_invoice: false,
	print_draft_invoice: false,
	shift_report: false,
	apply_additional_discount: false,
	show_edit_discount_field: false,
	allow_change_price: false,
	sale_return: false,
	recall_other_shift_tabs: false,
	settle_outstanding_invoice: false,
	sell_gift_card: false,
	redeem_gift_card: false,
	expense: false,
	bank_drop: false,
	current_stock_by_brand: false,
	current_stock_report: false,
};

const currentRole = ref<string>("");
const permissions = ref<PosPermissions>({ ...DEFAULT_PERMISSIONS });
const isLoaded = ref(false);

function mergePermissions(source: unknown): PosPermissions {
	const merged = { ...DEFAULT_PERMISSIONS };
	if (source && typeof source === "object") {
		for (const [key, val] of Object.entries(source as Record<string, unknown>)) {
			if (key in merged) {
				(merged as Record<string, boolean>)[key] = Boolean(val);
			}
		}
	}
	return merged;
}

export async function loadPermissions(userEmail: string, posProfile?: string): Promise<void> {
	if (!isElectron()) {
		const boot =
			(typeof window !== "undefined" ? (window.xpos?.boot as Record<string, unknown>) : undefined) ??
			{};
		currentRole.value = (boot.xpos_role as string) || "";
		try {
			const res = await call(
				"xpos.api.auth.get_my_pos_permissions",
				posProfile ? { pos_profile: posProfile } : {},
			);
			permissions.value = mergePermissions(res);
		} catch (err) {
			console.error("[UserRights] Failed to load permissions, using boot fallback:", err);
			permissions.value = mergePermissions(boot.xpos_permissions);
		}
		isLoaded.value = true;
		return;
	}

	try {
		const posUser = await window.electronAPI!.db.getPosUser(userEmail);
		if (posUser) {
			currentRole.value = ((posUser as Record<string, unknown>).role as string) || "";
			permissions.value = mergePermissions(posUser);
		} else {
			permissions.value = { ...DEFAULT_PERMISSIONS };
		}
	} catch (err) {
		console.error("[UserRights] Failed to load permissions:", err);
		permissions.value = { ...DEFAULT_PERMISSIONS };
	}

	isLoaded.value = true;
}

export function hasPermission(key: keyof PosPermissions): boolean {
	return permissions.value[key] ?? false;
}

export function getPermissions(): PosPermissions {
	return { ...permissions.value };
}

export function getCurrentRole(): string {
	return currentRole.value;
}

export function resetPermissions(): void {
	permissions.value = { ...DEFAULT_PERMISSIONS };
	currentRole.value = "";
	isLoaded.value = false;
}

export const usePermissions = () => ({
	permissions: computed(() => permissions.value),
	currentRole: computed(() => currentRole.value),
	isLoaded: computed(() => isLoaded.value),
	hasPermission,
	loadPermissions,
	resetPermissions,
});
