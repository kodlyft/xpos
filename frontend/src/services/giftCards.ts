import { call } from "@/services/api";
import type { GiftCardCheck, InvoiceData, IssuedGiftCard } from "@/types/pos.types";

/** Look up a card's balance. Needs a live connection; the answer is never cached. */
export function checkGiftCard(code: string, posProfile: string): Promise<GiftCardCheck> {
	return call<GiftCardCheck>("xpos.api.gift_cards.check_gift_card", {
		code: code.trim(),
		pos_profile: posProfile,
	});
}

/** Codes of the cards sold on an invoice, if the sale response never reached this till. */
export function claimIssuedGiftCards(invoice: string, doctype = "Sales Invoice"): Promise<IssuedGiftCard[]> {
	return call<IssuedGiftCard[]>("xpos.api.gift_cards.claim_issued_gift_cards", { invoice, doctype });
}

/** Whether a sale sells or spends a gift card. Such sales must never be queued offline. */
export function hasGiftCardActivity(data: Pick<InvoiceData, "items" | "payments">): boolean {
	return (
		(data.items || []).some((item) => item.gift_card_issue || item.gift_card) ||
		(data.payments || []).some((payment) => payment.gift_card_auth || payment.gift_card)
	);
}
