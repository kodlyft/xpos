# Copyright (c) 2026, Ali Raza and contributors
# For license information, please see license.txt

"""
Stored-value gift cards.

A card is money the store owes its holder. It is sold as a non-stock item whose
income account is the gift-card liability account, and spent through a Mode of
Payment whose account is that same liability, so ERPNext posts the GL. This
module keeps the per-card ledger (Gift Card Transaction) and moves it inside the
invoice's own submit or cancel transaction. Codes are stored only as hashes.
"""

import hashlib
import secrets

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import add_days, cint, flt, getdate

from xpos.api.exchange import get_currency_precision

CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"  # Crockford base32: no I, L, O, U
CODE_LENGTH = 16
AUTH_TTL = 15 * 60
ISSUED_TTL = 15 * 60
SETTINGS = "Gift Card Settings"


class GiftCardAuthError(frappe.ValidationError):
	pass


def live_connection_message() -> str:
	return _("Gift card payments need a live connection. Check the gift card again and re-tender this sale.")


class DuplicateGiftCardOperation(frappe.ValidationError):
	pass


def normalize_code(code: str | None) -> str:
	code = (code or "").upper().replace("-", "").replace(" ", "")
	return code.translate(str.maketrans("OIL", "011"))


def generate_code() -> str:
	raw = "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))
	return "-".join(raw[i : i + 4] for i in range(0, CODE_LENGTH, 4))


def hash_code(code: str) -> str:
	return hashlib.sha256(normalize_code(code).encode()).hexdigest()


def mask_code(last4: str | None) -> str:
	return f"••••-{last4 or '????'}"


def tolerance(currency: str) -> float:
	return 10.0 ** -get_currency_precision(currency) / 2


def get_company_setting(company: str | None):
	if not company or not frappe.db.exists("DocType", SETTINGS):
		return None
	for row in frappe.get_cached_doc(SETTINGS).companies:
		if row.company == company:
			return row
	return None


def gift_card_config(profile) -> dict | None:
	"""What the till needs to sell and take gift cards on ``profile``, or None when it may not."""
	setting = get_company_setting(profile.company) if profile.get("xpos_enable_gift_cards") else None
	if not setting:
		return None
	return {
		"mode_of_payment": setting.mode_of_payment,
		"item": setting.issue_item,
		"min_amount": flt(setting.min_amount),
		"max_amount": flt(setting.max_amount),
	}


def gift_card_mode(company: str | None) -> str | None:
	setting = get_company_setting(company)
	return setting.mode_of_payment if setting else None


class GiftCardController(Document):
	def validate(self):
		if not self.flags.via_gift_card_service:
			frappe.throw(_("Gift cards are issued and changed only through POS sales and adjustments."))

	def on_trash(self):
		if not frappe.flags.xpos_purge_gift_cards:
			frappe.throw(_("Gift cards cannot be deleted. Void them through a return instead."))


class GiftCardTransactionController(Document):
	def validate(self):
		if not self.is_new() or not self.flags.via_gift_card_service:
			frappe.throw(_("Gift card transactions cannot be created or edited by hand."))

	def on_trash(self):
		if not frappe.flags.xpos_purge_gift_cards:
			frappe.throw(_("Gift card transactions cannot be deleted."))


class GiftCardSettingsController(Document):
	def validate(self):
		seen = set()
		for row in self.companies:
			if row.company in seen:
				frappe.throw(_("Row {0}: Company {1} is listed twice.").format(row.idx, row.company))
			seen.add(row.company)
			validate_company_setting(row)


def validate_company_setting(row):
	account = frappe.db.get_value(
		"Account",
		row.liability_account,
		["company", "root_type", "is_group", "account_type", "account_currency"],
		as_dict=True,
	)
	if not account or account.company != row.company:
		frappe.throw(
			_("Row {0}: Account {1} does not belong to {2}.").format(
				row.idx, row.liability_account, row.company
			)
		)
	if account.is_group or account.root_type != "Liability":
		frappe.throw(
			_("Row {0}: {1} must be a ledger account under Liabilities.").format(
				row.idx, row.liability_account
			)
		)
	if account.account_type in ("Receivable", "Payable"):
		frappe.throw(
			_("Row {0}: {1} cannot be a Receivable or Payable account; leave its Account Type empty.").format(
				row.idx, row.liability_account
			)
		)
	company_currency = frappe.get_cached_value("Company", row.company, "default_currency")
	if account.account_currency and account.account_currency != company_currency:
		frappe.throw(
			_("Row {0}: {1} must be in {2}.").format(row.idx, row.liability_account, company_currency)
		)

	if frappe.db.get_value("Mode of Payment", row.mode_of_payment, "type") != "General":
		frappe.throw(
			_("Row {0}: Mode of Payment {1} must be of type General.").format(row.idx, row.mode_of_payment)
		)
	mode_account = frappe.db.get_value(
		"Mode of Payment Account",
		{"parent": row.mode_of_payment, "company": row.company},
		"default_account",
	)
	if mode_account != row.liability_account:
		frappe.throw(
			_("Row {0}: Mode of Payment {1} must post to {2} for {3}.").format(
				row.idx, row.mode_of_payment, row.liability_account, row.company
			)
		)

	item = frappe.db.get_value(
		"Item", row.issue_item, ["is_stock_item", "is_sales_item", "disabled"], as_dict=True
	)
	if not item or item.is_stock_item or not item.is_sales_item or item.disabled:
		frappe.throw(
			_("Row {0}: Item {1} must be an enabled, non-stock sales item.").format(row.idx, row.issue_item)
		)
	if flt(row.max_amount) and flt(row.min_amount) > flt(row.max_amount):
		frappe.throw(_("Row {0}: Minimum card value is above the maximum.").format(row.idx))


def find_card_by_code(code: str):
	if len(normalize_code(code)) != CODE_LENGTH:
		return None
	return frappe.db.get_value(
		"Gift Card",
		{"code_hash": hash_code(code)},
		["name", "company", "currency", "status", "balance", "valid_upto", "code_last4"],
		as_dict=True,
	)


def card_rejection(card, company: str, currency: str, on_date=None) -> str | None:
	"""Why ``card`` cannot pay a ``company``/``currency`` sale today, or None."""
	if not card or card.status == "Voided":
		return _("This gift card is not valid.")
	if card.company != company or card.currency != currency:
		return _("This gift card is not valid here.")
	if card.valid_upto and getdate(on_date) > getdate(card.valid_upto):
		return _("This gift card expired on {0}.").format(frappe.format(card.valid_upto, "Date"))
	if card.status == "Depleted" or flt(card.balance) <= 0:
		return _("This gift card has no balance left.")
	return None


def require_gift_card_access(permission: str, pos_profile: str | None):
	"""The profile takes gift cards and the user works on it with ``permission``; returns its setting."""
	from xpos.api.auth import is_superuser, user_has_pos_permission
	from xpos.api.utilities import pos_profile_flag

	user = frappe.session.user
	if not pos_profile or not pos_profile_flag(pos_profile, "xpos_enable_gift_cards"):
		frappe.throw(_("Gift cards are not enabled on this POS Profile."), frappe.PermissionError)
	setting = get_company_setting(frappe.db.get_value("POS Profile", pos_profile, "company"))
	if not setting:
		frappe.throw(_("Gift cards are not set up for this company."), frappe.PermissionError)
	on_profile = frappe.db.exists(
		"POS Profile User", {"parent": pos_profile, "parenttype": "POS Profile", "user": user}
	)
	if not is_superuser(user) and not (on_profile and user_has_pos_permission(permission, user, pos_profile)):
		frappe.throw(
			_("You are not permitted to use gift cards on this POS Profile."), frappe.PermissionError
		)
	return setting


def issue_auth_token(gift_card: str, user: str, pos_profile: str | None) -> str:
	token = secrets.token_urlsafe(24)
	frappe.cache.set_value(
		f"xpos_gc_auth:{token}",
		{"gift_card": gift_card, "user": user, "pos_profile": pos_profile},
		expires_in_sec=AUTH_TTL,
	)
	return token


def read_auth_token(token: str | None) -> dict | None:
	if not token:
		return None
	return frappe.cache.get_value(f"xpos_gc_auth:{token}")


def check_payment_auth(doc, row):
	auth = read_auth_token(row.get("xpos_gift_card_auth"))
	if (
		not auth
		or auth.get("gift_card") != row.xpos_gift_card
		or auth.get("user") != frappe.session.user
		or (doc.get("pos_profile") and auth.get("pos_profile") != doc.pos_profile)
	):
		frappe.throw(live_connection_message(), GiftCardAuthError)


def lock_card(name: str):
	"""Lock a card until the transaction ends and return its latest committed state."""
	card = frappe.db.get_value(
		"Gift Card",
		name,
		[
			"name",
			"company",
			"currency",
			"status",
			"balance",
			"issued_value",
			"valid_upto",
			"issue_voucher",
			"code_last4",
		],
		as_dict=True,
		for_update=True,
	)
	if not card:
		frappe.throw(_("This gift card is not valid."))
	return card


def ledger_balance(gift_card: str) -> float:
	# a locking read, so rows committed by other terminals are seen
	return flt(
		frappe.db.sql(
			"select coalesce(sum(amount), 0) from `tabGift Card Transaction` where gift_card=%s for update",
			gift_card,
		)[0][0]
	)


def add_transaction(
	card,
	transaction_type,
	amount,
	voucher=None,
	detail=None,
	operation_id=None,
	reverses=None,
	status=None,
	remarks=None,
):
	"""Write one ledger row and move the card's cached balance with it."""
	precision = get_currency_precision(card.currency)
	amount = flt(amount, precision)
	balance = flt(flt(card.balance) + amount, precision)
	if balance < -tolerance(card.currency):
		frappe.throw(
			_("Gift card {0} has only {1} left.").format(
				mask_code(card.code_last4),
				frappe.format(card.balance, {"fieldtype": "Currency", "options": card.currency}),
			)
		)
	if frappe.db.exists("Gift Card Transaction", {"operation_id": operation_id}):
		frappe.throw(_("This gift card operation was already recorded."), DuplicateGiftCardOperation)

	txn = frappe.get_doc(
		{
			"doctype": "Gift Card Transaction",
			"gift_card": card.name,
			"transaction_type": transaction_type,
			"amount": amount,
			"balance_after": balance,
			"company": card.company,
			"currency": card.currency,
			"posting_date": (voucher.get("posting_date") if voucher else None) or getdate(),
			"user": frappe.session.user,
			"voucher_type": voucher.doctype if voucher else None,
			"voucher_no": voucher.name if voucher else None,
			"voucher_detail_no": detail,
			"reverses": reverses,
			"operation_id": operation_id,
			"remarks": remarks,
		}
	)
	txn.flags.via_gift_card_service = True
	txn.insert(ignore_permissions=True)

	if abs(ledger_balance(card.name) - balance) > tolerance(card.currency):
		frappe.throw(_("Gift card {0} ledger does not match its balance.").format(mask_code(card.code_last4)))

	status = status or ("Depleted" if balance <= 0 else "Active")
	frappe.db.set_value("Gift Card", card.name, {"balance": balance, "status": status})
	card.balance = balance
	card.status = status
	return txn


def create_card(doc, item, setting):
	currency = doc.currency
	precision = get_currency_precision(currency)
	code = generate_code()
	card = frappe.get_doc(
		{
			"doctype": "Gift Card",
			"company": doc.company,
			"currency": currency,
			"code_hash": hash_code(code),
			"code_last4": normalize_code(code)[-4:],
			"status": "Active",
			"issued_value": flt(item.amount, precision),
			"balance": 0,
			"valid_upto": add_days(doc.posting_date, cint(setting.validity_days))
			if cint(setting.validity_days)
			else None,
			"issue_voucher_type": doc.doctype,
			"issue_voucher": doc.name,
			"issue_voucher_detail": item.name,
			"purchaser": doc.customer,
		}
	)
	card.flags.via_gift_card_service = True
	card.insert(ignore_permissions=True)
	locked = lock_card(card.name)
	add_transaction(
		locked, "Issue", item.amount, doc, item.name, f"issue:{doc.doctype}:{doc.name}:{item.name}"
	)
	return code, locked


def gift_rows_of(doc, mode):
	return [
		p
		for p in doc.get("payments") or []
		if p.get("xpos_gift_card") or (mode and p.mode_of_payment == mode)
	]


def issue_rows_of(doc, setting):
	return [i for i in doc.get("items") or [] if setting and i.item_code == setting.issue_item]


def validate_invoice_gift_cards(doc, method=None):
	if doc.get("is_consolidated"):
		return
	setting = get_company_setting(doc.company)
	mode = setting.mode_of_payment if setting else None
	gift_rows = gift_rows_of(doc, mode)
	issue_rows = issue_rows_of(doc, setting)
	if not gift_rows and not issue_rows:
		return

	if not setting:
		frappe.throw(_("Gift cards are not set up for {0}.").format(doc.company))
	set_gift_card_totals(doc, bool(issue_rows))
	company_currency = frappe.get_cached_value("Company", doc.company, "default_currency")
	if doc.currency != company_currency:
		frappe.throw(_("Gift cards can only be used on {0} invoices.").format(company_currency))

	tol = tolerance(doc.currency)
	sign = -1 if doc.is_return else 1

	for row in gift_rows:
		if row.mode_of_payment != mode:
			frappe.throw(_("Row {0}: a gift card can only be paid with {1}.").format(row.idx, mode))
		if not row.get("xpos_gift_card"):
			frappe.throw(_("Row {0}: scan the gift card to pay with {1}.").format(row.idx, mode))
		if row.get("pos_tender_currency") and row.pos_tender_currency != doc.currency:
			frappe.throw(_("Row {0}: gift cards cannot be tendered in another currency.").format(row.idx))
		if flt(row.amount) * sign <= 0:
			frappe.throw(
				_("Row {0}: gift card amount must be {1}.").format(
					row.idx, _("negative") if doc.is_return else _("positive")
				)
			)

	if gift_rows and not doc.is_return:
		gift_total = sum(flt(row.amount) for row in gift_rows)
		due = flt(doc.rounded_total) or flt(doc.grand_total)
		if gift_total > due + tol:
			frappe.throw(_("Gift cards can pay at most the invoice total of {0}.").format(due))
		other_tender = sum(flt(p.amount) for p in doc.payments if p not in gift_rows)
		if flt(doc.change_amount) > other_tender + tol:
			frappe.throw(_("Change can only be given from cash, never from a gift card."))

	if issue_rows:
		if len(issue_rows) != len(doc.items):
			frappe.throw(_("Sell gift cards on their own invoice, without other items."))
		if gift_rows:
			frappe.throw(_("A gift card cannot be paid for with another gift card."))
		if doc.get("redeem_loyalty_points") or any(c.get("applied") for c in doc.get("coupons") or []):
			frappe.throw(_("Loyalty points and coupons cannot be used to buy a gift card."))
		if flt(doc.discount_amount) or flt(doc.write_off_amount):
			frappe.throw(_("Gift card sales cannot carry discounts or write-offs."))
		for item in issue_rows:
			item.income_account = setting.liability_account
			if flt(item.qty) != sign:
				frappe.throw(_("Row {0}: sell one gift card per line.").format(item.idx))
			if flt(item.discount_percentage) or flt(item.discount_amount):
				frappe.throw(_("Row {0}: gift cards cannot be discounted.").format(item.idx))
			value = abs(flt(item.amount))
			if flt(setting.min_amount) and value < flt(setting.min_amount) - tol:
				frappe.throw(
					_("Row {0}: the minimum gift card value is {1}.").format(item.idx, setting.min_amount)
				)
			if flt(setting.max_amount) and value > flt(setting.max_amount) + tol:
				frappe.throw(
					_("Row {0}: the maximum gift card value is {1}.").format(item.idx, setting.max_amount)
				)
		if not doc.is_return:
			paid = flt(doc.paid_amount) - flt(doc.change_amount)
			if paid < (flt(doc.rounded_total) or flt(doc.grand_total)) - tol:
				frappe.throw(_("A gift card must be paid in full before it is issued."))


def set_gift_card_totals(doc, is_card_sale):
	"""Card value is exact money: no cash rounding, and a card sale carries no sales tax
	(tax is charged on the goods when the card is spent)."""
	changed = False
	if is_card_sale and (doc.get("taxes") or doc.get("taxes_and_charges")):
		doc.taxes_and_charges = None
		doc.set("taxes", [])
		changed = True
	if not doc.get("disable_rounded_total"):
		doc.disable_rounded_total = 1
		changed = True
	if changed:
		doc.calculate_taxes_and_totals()


def apply_gift_cards_on_submit(doc, method=None):
	if doc.get("is_consolidated"):
		return
	setting = get_company_setting(doc.company)
	if not setting:
		return
	gift_rows = sorted(gift_rows_of(doc, setting.mode_of_payment), key=lambda r: r.xpos_gift_card)
	issue_rows = issue_rows_of(doc, setting)

	if doc.is_return:
		refund_to_cards(doc, gift_rows)
		void_returned_cards(doc, issue_rows)
		return

	cards = {}
	for row in gift_rows:
		check_payment_auth(doc, row)
		card = cards.get(row.xpos_gift_card) or lock_card(row.xpos_gift_card)
		cards[card.name] = card
		rejection = card_rejection(card, doc.company, doc.currency, doc.posting_date)
		if rejection:
			frappe.throw(rejection)
		add_transaction(
			card, "Redeem", -flt(row.amount), doc, row.name, f"redeem:{doc.doctype}:{doc.name}:{row.name}"
		)

	issued = []
	for item in issue_rows:
		code, card = create_card(doc, item, setting)
		item.xpos_gift_card = card.name
		issued.append(
			{
				"gift_card": card.name,
				"code": code,
				"masked_code": mask_code(card.code_last4),
				"amount": card.balance,
				"currency": card.currency,
				"valid_upto": str(card.valid_upto) if card.valid_upto else None,
			}
		)
	if issued:
		doc.flags.xpos_issued_gift_cards = issued
		key = issued_cache_key(doc.doctype, doc.name)
		user = frappe.session.user
		# only remember codes for cards that really exist, i.e. after the sale commits
		frappe.db.after_commit.add(
			lambda: frappe.cache.set_value(key, {"user": user, "cards": issued}, expires_in_sec=ISSUED_TTL)
		)


def refundable(gift_card: str, doctype: str, invoice: str):
	"""The Redeem rows of ``gift_card`` on ``invoice`` and how much can still go back to it."""
	originals = frappe.get_all(
		"Gift Card Transaction",
		filters={
			"gift_card": gift_card,
			"voucher_type": doctype,
			"voucher_no": invoice,
			"transaction_type": "Redeem",
		},
		fields=["name", "amount"],
		order_by="creation asc",
	)
	if not originals:
		return originals, 0.0
	refunds = frappe.get_all(
		"Gift Card Transaction",
		filters={"reverses": ("in", [t.name for t in originals]), "transaction_type": "Refund"},
		fields=["name", "amount"],
	)
	# a cancelled return takes its refund back off the card, so it can be refunded again
	undone = (
		frappe.get_all(
			"Gift Card Transaction",
			filters={"reverses": ("in", [t.name for t in refunds])},
			fields=["amount"],
		)
		if refunds
		else []
	)
	redeemed = -sum(flt(t.amount) for t in originals)
	refunded = sum(flt(t.amount) for t in refunds) + sum(flt(t.amount) for t in undone)
	return originals, redeemed - refunded


def refunds_available(doctype: str, invoice: str) -> list:
	"""Each card that paid ``invoice``, with what a return may still put back on it."""
	cards = frappe.get_all(
		"Gift Card Transaction",
		filters={"voucher_type": doctype, "voucher_no": invoice, "transaction_type": "Redeem"},
		pluck="gift_card",
		distinct=True,
	)
	result = []
	for name in sorted(set(cards)):
		card = frappe.db.get_value("Gift Card", name, ["code_last4", "currency", "status"], as_dict=True)
		_originals, available = refundable(name, doctype, invoice)
		if card.status != "Voided" and available > 0:
			result.append(
				{
					"gift_card": name,
					"masked_code": mask_code(card.code_last4),
					"amount": flt(available, get_currency_precision(card.currency)),
				}
			)
	return result


def refund_to_cards(doc, gift_rows):
	for row in gift_rows:
		card = lock_card(row.xpos_gift_card)
		if card.status == "Voided":
			frappe.throw(
				_("Gift card {0} was voided; refund this amount another way.").format(
					mask_code(card.code_last4)
				)
			)
		originals, available = refundable(card.name, doc.doctype, doc.return_against)
		if not originals:
			frappe.throw(
				_("Gift card {0} was not used on {1}.").format(mask_code(card.code_last4), doc.return_against)
			)
		amount = -flt(row.amount)
		if amount > available + tolerance(card.currency):
			frappe.throw(
				_("At most {0} can still be refunded to gift card {1}.").format(
					flt(available, get_currency_precision(card.currency)), mask_code(card.code_last4)
				)
			)
		add_transaction(
			card,
			"Refund",
			amount,
			doc,
			row.name,
			f"refund:{doc.doctype}:{doc.name}:{row.name}",
			reverses=originals[0].name,
		)


def untouched_issue(card):
	"""The Issue row of a card holding its full issued value (nothing spent, or every spend reversed)."""
	if card.status != "Active" or abs(flt(card.balance) - flt(card.issued_value)) > tolerance(card.currency):
		return None
	return frappe.db.get_value(
		"Gift Card Transaction", {"gift_card": card.name, "transaction_type": "Issue"}, "name"
	)


def void_returned_cards(doc, issue_rows):
	for item in issue_rows:
		if not item.get("xpos_gift_card"):
			frappe.throw(_("Row {0}: choose the gift card being returned.").format(item.idx))
		card = lock_card(item.xpos_gift_card)
		if card.issue_voucher != doc.return_against:
			frappe.throw(
				_("Row {0}: this gift card was not sold on {1}.").format(item.idx, doc.return_against)
			)
		issue = untouched_issue(card)
		if not issue or abs(abs(flt(item.amount)) - flt(card.issued_value)) > tolerance(card.currency):
			frappe.throw(
				_("Gift card {0} has been used, so it can no longer be returned.").format(
					mask_code(card.code_last4)
				)
			)
		add_transaction(
			card,
			"Void",
			-card.balance,
			doc,
			item.name,
			f"void:{doc.doctype}:{doc.name}:{item.name}",
			reverses=issue,
			status="Voided",
		)


REVERSAL = {"Issue": "Void", "Redeem": "Refund", "Refund": "Redeem", "Void": "Issue"}


def reverse_gift_cards_on_cancel(doc, method=None):
	if doc.get("is_consolidated"):
		return
	txns = frappe.get_all(
		"Gift Card Transaction",
		filters={
			"voucher_type": doc.doctype,
			"voucher_no": doc.name,
			"operation_id": ("not like", "cancel:%"),
		},
		fields=["name", "gift_card", "transaction_type", "amount"],
		order_by="gift_card asc, creation asc",
	)
	cards = {}
	for txn in txns:
		card = cards.get(txn.gift_card) or lock_card(txn.gift_card)
		cards[card.name] = card
		status = None
		if txn.transaction_type == "Issue":
			if untouched_issue(card) != txn.name:
				frappe.throw(
					_("Gift card {0} has been used, so this sale can no longer be cancelled.").format(
						mask_code(card.code_last4)
					)
				)
			status = "Voided"
		elif card.status == "Voided":
			frappe.throw(
				_("Gift card {0} was voided, so this can no longer be cancelled.").format(
					mask_code(card.code_last4)
				)
			)
		elif txn.transaction_type == "Void":
			status = "Active"
		add_transaction(
			card,
			REVERSAL[txn.transaction_type],
			-flt(txn.amount),
			doc,
			None,
			f"cancel:{txn.name}",
			reverses=txn.name,
			status=status,
			remarks=_("Cancellation of {0}").format(doc.name),
		)


def issued_cache_key(doctype: str, name: str) -> str:
	return f"xpos_gc_issued:{doctype}:{name}"


def claim_issued_codes(doctype: str, name: str) -> list:
	"""Hand the plaintext codes of a sale's new cards to its cashier, once."""
	key = issued_cache_key(doctype, name)
	entry = frappe.cache.get_value(key)
	if not entry or entry.get("user") != frappe.session.user:
		return []
	frappe.cache.delete_value(key)
	return [
		card
		for card in entry.get("cards") or []
		if frappe.db.exists("Gift Card", {"name": card["gift_card"], "issue_voucher": name})
	]


def payment_summary(doc) -> list:
	"""Masked card and balance left after this sale, for each gift-card tender row."""
	rows = frappe.get_all(
		"Gift Card Transaction",
		filters={
			"voucher_type": doc.doctype,
			"voucher_no": doc.name,
			"transaction_type": ("in", ["Redeem", "Refund"]),
		},
		fields=["gift_card", "voucher_detail_no", "amount", "balance_after"],
	)
	last4 = (
		dict(
			frappe.get_all(
				"Gift Card",
				filters={"name": ("in", [r.gift_card for r in rows])},
				fields=["name", "code_last4"],
				as_list=True,
			)
		)
		if rows
		else {}
	)
	return [
		{
			"payment_row": r.voucher_detail_no,
			"gift_card": r.gift_card,
			"masked_code": mask_code(last4.get(r.gift_card)),
			"amount": -flt(r.amount),
			"balance_after": r.balance_after,
		}
		for r in rows
	]
