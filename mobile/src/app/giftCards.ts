/**
 * Gift cards use the existing XPOS service as it is: a live balance check hands out a short-lived token that lets this
 * cashier spend that card on one sale, and a card is sold as an invoice line. The server owns balances, eligibility and
 * the ledger; the phone only ever sees the masked code, the balance left and, once, the code of a card it just sold.
 */
import type { ApiTransport } from "@mobile/ports";
import { fromRate } from "@mobile/domain/money";

export interface GiftCardCheck {
	maskedCode: string;
	balanceMinor: number;
	validUpto: string | null;
	modeOfPayment: string;
	auth: string;
}

interface CheckReply {
	masked_code: string;
	balance: number;
	valid_upto?: string | null;
	mode_of_payment: string;
	auth: string;
}

export async function checkGiftCard(
	api: ApiTransport,
	profile: string,
	code: string,
	minorDigits: number,
): Promise<GiftCardCheck> {
	const r = await api.call<CheckReply>("xpos.api.gift_cards.check_gift_card", {
		code: code.trim(),
		pos_profile: profile,
	});
	return {
		maskedCode: r.masked_code,
		balanceMinor: fromRate(Number(r.balance), minorDigits),
		validUpto: r.valid_upto ?? null,
		modeOfPayment: r.mode_of_payment,
		auth: r.auth,
	};
}

export interface IssuedCard {
	code: string;
	maskedCode: string;
	amount: number;
	validUpto: string | null;
}

/**
 * New card codes are shown on screen once and kept only in memory: they are never written to the device's sale record,
 * so a lost phone cannot leak spendable codes. Taking them removes them.
 */
const issued = new Map<string, IssuedCard[]>();

export function holdIssuedCards(txnId: string, reply: unknown): void {
	const cards = (
		reply as {
			issued_gift_cards?: {
				code?: string;
				masked_code?: string;
				amount?: number;
				valid_upto?: string | null;
			}[];
		}
	).issued_gift_cards;
	if (cards?.length)
		issued.set(
			txnId,
			cards
				.filter((c) => c.code)
				.map((c) => ({
					code: String(c.code),
					maskedCode: c.masked_code ?? "",
					amount: Number(c.amount ?? 0),
					validUpto: c.valid_upto ?? null,
				})),
		);
}

export function takeIssuedCards(txnId: string): IssuedCard[] {
	const cards = issued.get(txnId) ?? [];
	issued.delete(txnId);
	return cards;
}

/** Removes the plaintext codes from a server reply before it is stored. */
export function withoutCodes(reply: Record<string, unknown>): Record<string, unknown> {
	const { issued_gift_cards: cards, ...rest } = reply;
	return Array.isArray(cards) && cards.length ? { ...rest, issued_gift_cards_count: cards.length } : rest;
}
