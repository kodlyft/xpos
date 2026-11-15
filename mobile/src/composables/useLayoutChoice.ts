import { LayoutGrid, ScanBarcode, Shirt } from "@lucide/vue";
import { ref, watch } from "vue";

export const SELLING_LAYOUTS = [
	{
		id: "catalog",
		label: "Catalog",
		short: "Catalog",
		hint: "Browse and search products",
		icon: LayoutGrid,
	},
	{
		id: "scan",
		label: "Scan Counter",
		short: "Scan",
		hint: "Scan-first, compact lines",
		icon: ScanBarcode,
	},
	{ id: "fashion", label: "Fashion Assist", short: "Fashion", hint: "Pick colour and size", icon: Shirt },
] as const;
export type SellingLayout = (typeof SELLING_LAYOUTS)[number]["id"];

const KEY = "xpos-mobile-layout";
function initial(): SellingLayout {
	try {
		const v = localStorage.getItem(KEY);
		if (SELLING_LAYOUTS.some((l) => l.id === v)) return v as SellingLayout;
	} catch {
		/* default */
	}
	return "catalog";
}
const layout = ref<SellingLayout>(initial());
watch(layout, (v) => {
	try {
		localStorage.setItem(KEY, v);
	} catch {
		/* preference only */
	}
});
export const useLayoutChoice = () => layout;
