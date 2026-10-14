import { formatFor, formatWithSymbol } from "@/composables/useCurrency";
import type { IssuedGiftCard, ReceiptContext, ReceiptSnapshot } from "@/types/pos.types";
import { __ } from "@/lib/translate";
import { formatFloat, formatQty } from "@/utils/numberFormat";

function esc(value: unknown): string {
	return String(value ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function fmtMoney(amount: number, currency: string): string {
	return formatWithSymbol(currency, Number(amount || 0));
}

function fmtNative(amount: number, currency: string): string {
	return `${currency} ${formatFor(currency, amount)}`;
}

function fmtDate(date: string): string {
	const parts = String(date || "").split("-");
	if (parts.length === 3) return `${parts[2]}-${parts[1]}-${parts[0]}`;
	return date || "";
}

function fmtTime(time: string): string {
	const parts = String(time || "").split(":");
	if (parts.length < 2) return time || "";
	let hour = Number(parts[0]);
	const minute = parts[1];
	const period = hour >= 12 ? "PM" : "AM";
	hour = hour % 12 || 12;
	return `${String(hour).padStart(2, "0")}:${minute} ${period}`;
}

export function buildReceiptHtml(snapshot: ReceiptSnapshot, ctx: ReceiptContext): string {
	const currency = ctx.currency;
	const money = (amount: number) => fmtMoney(amount, currency);
	const isReturn = snapshot.is_return;

	const logo = ctx.company_logo
		? `<img class="store-logo-left" src="${esc(ctx.company_logo)}" alt="${esc(ctx.company_name)}" />`
		: "";

	const contactLine = [
		ctx.company_phone ? `Tel: ${esc(ctx.company_phone)}` : "",
		ctx.company_email ? esc(ctx.company_email) : "",
	]
		.filter(Boolean)
		.join(" &bull; ");

	const itemsHtml = snapshot.items
		.map((item) => {
			const codeLine =
				item.item_code && item.item_code !== item.item_name
					? `<span style="font-size:9px;color:#333;font-weight:600;">${esc(item.item_code)}</span>`
					: "";
			const uomLine =
				item.uom && item.uom !== "Nos" && item.uom !== "Unit"
					? `<div class="item-extras">UOM: ${esc(item.uom)}</div>`
					: "";
			const serialLine = item.serial_no
				? `<div class="item-extras">S/N: ${esc(item.serial_no)}</div>`
				: "";
			const batchLine = item.batch_no
				? `<div class="item-extras">Batch: ${esc(item.batch_no)}</div>`
				: "";
			let discountLine = "";
			if (item.discount_percentage && item.discount_percentage > 0) {
				discountLine = ctx.print_discount_amount
					? `<div class="item-discount">Discount: ${money(item.discount_amount || 0)}</div>`
					: `<div class="item-discount">Discount: ${formatFloat(item.discount_percentage)}%</div>`;
			} else if (item.discount_amount && item.discount_amount > 0) {
				discountLine = `<div class="item-discount">Discount: ${money(item.discount_amount)}</div>`;
			}
			const notesLine = item.pos_notes
				? `<div class="item-extras" style="font-style:italic;">&#9998; ${esc(item.pos_notes)}</div>`
				: "";
			return `
    <div class="item-row">
        <div class="item-name">${esc(item.item_name)}</div>
        <div class="item-detail-line">
            <span class="col-desc" style="flex:1;">${codeLine}</span>
            <span class="col-qty">${formatQty(item.qty)}</span>
            <span class="col-rate">${formatFor(currency, item.rate)}</span>
            <span class="col-amt">${formatFor(currency, item.amount)}</span>
        </div>
        ${uomLine}${serialLine}${batchLine}${discountLine}${notesLine}
    </div>`;
		})
		.join("");

	const taxesHtml = snapshot.taxes
		.map(
			(tax) => `
        <div class="total-row tax">
            <span class="total-label">${esc(tax.description || "Tax")}${
				tax.rate ? ` (${tax.rate}%)` : ""
			}${tax.included_in_print_rate ? ' <span style="font-size:7px;">Incl.</span>' : ""}</span>
            <span class="total-value">${money(tax.amount)}</span>
        </div>`,
		)
		.join("");

	const discountRow =
		snapshot.total_discount > 0.001
			? `
        <div class="total-row discount">
            <span class="total-label">Total Discount</span>
            <span class="total-value">-${money(snapshot.total_discount)}</span>
        </div>`
			: "";

	const netTotalRow =
		Math.abs(snapshot.net_total - snapshot.subtotal) > 0.001
			? `
        <div class="total-row">
            <span class="total-label">Net Total</span>
            <span class="total-value">${money(snapshot.net_total)}</span>
        </div>`
			: "";

	const paymentRowHtml = (p: ReceiptSnapshot["payments"][number]) => {
		const isForeign = !!p.currency && p.currency !== currency && p.native_amount !== undefined;
		const headline = isForeign
			? fmtNative(Math.abs(p.native_amount!), p.currency!)
			: money(Math.abs(p.amount));
		const rateLine = isForeign
			? `
        <div class="payment-rate-line" style="font-size:8px;color:#555;padding-left:6px;">
            @ ${formatFor(currency, p.exchange_rate || 0)}${
				p.rate_date ? ` (${fmtDate(p.rate_date)})` : ""
			} = ${money(Math.abs(p.amount))}
        </div>`
			: "";
		return `
        <div class="payment-row">
            <span>${esc(p.mode_of_payment)}</span>
            <span style="font-weight:700;">${headline}</span>
        </div>${rateLine}`;
	};

	const changeLegs = snapshot.change_legs || [];

	const changeHtml =
		snapshot.change > 0.01
			? changeLegs.length
				? `
        <hr class="div-dashed">
        <div class="total-row" style="font-size:9px;font-weight:700;text-transform:uppercase;color:#000;margin-bottom:2px;">
            <span>Change</span>
        </div>
        ${changeLegs
			.map(
				(leg) => `
        <div class="payment-row change-leg-row">
            <span>${esc(leg.mode_of_payment)}</span>
            <span>${
				leg.currency && leg.currency !== currency
					? fmtNative(leg.amount, leg.currency)
					: money(leg.amount)
			}</span>
        </div>`,
			)
			.join("")}
        <div class="payment-row change-row" style="font-weight:700;">
            <span>Total Change</span>
            <span>${money(snapshot.change)}</span>
        </div>`
				: `
        <hr class="div-dashed">
        <div class="payment-row change-row">
            <span>Change</span>
            <span>${money(snapshot.change)}</span>
        </div>`
			: "";

	const paymentsHtml = snapshot.payments.length
		? `
    <hr class="div-dashed">
    <div class="payments-section">
        <div class="total-row" style="font-size:9px;font-weight:700;text-transform:uppercase;color:#000;margin-bottom:2px;">
            <span>Payment Details</span>
        </div>
        ${snapshot.payments.map(paymentRowHtml).join("")}
        ${changeHtml}
    </div>`
		: "";

	const totalItems = snapshot.items.length;

	return `<style>${ctx.css}</style>
<div class="receipt-container">
    <div class="receipt-header">
        <div class="header-top">
            ${logo}
            <div class="store-name-right">${esc(ctx.company_name)}</div>
        </div>
        ${ctx.receipt_header ? `<div class="receipt-header-html">${ctx.receipt_header}</div>` : ""}
        <div class="store-detail">
            ${ctx.company_address ? `${esc(ctx.company_address)}<br>` : ""}
            ${contactLine}
            ${ctx.company_website ? `<br>${esc(ctx.company_website)}` : ""}
        </div>
        ${ctx.company_tax_id ? `<div class="store-tax-id">Tax ID: ${esc(ctx.company_tax_id)}</div>` : ""}
    </div>

    ${isReturn ? '<div class="return-banner">&#x21A9; RETURN / REFUND</div>' : ""}

    <hr class="div-dashed">

    <div class="invoice-meta">
        <div class="meta-row">
            <span class="meta-label">Invoice:</span>
            <span class="meta-value invoice-number">${esc(snapshot.name)}</span>
        </div>
        <div class="meta-row">
            <span class="meta-label">Date:</span>
            <span class="meta-value">${fmtDate(snapshot.posting_date)} ${fmtTime(snapshot.posting_time)}</span>
        </div>
        ${
			snapshot.cashier
				? `<div class="meta-row">
            <span class="meta-label">Cashier:</span>
            <span class="meta-value">${esc(snapshot.cashier)}</span>
        </div>`
				: ""
		}
    </div>

    ${
		snapshot.customer_name
			? `<div class="customer-section">
        <div class="meta-row">
            <span class="meta-label">Customer:</span>
            <span class="customer-name">${esc(snapshot.customer_name)}</span>
        </div>
    </div>`
			: ""
	}

    <hr class="div-solid">

    <div class="items-header">
        <span class="col-desc">Item</span>
        <span class="col-qty">Qty</span>
        <span class="col-rate">Price</span>
        <span class="col-amt">Total</span>
    </div>
    ${itemsHtml}

    <hr class="div-double">

    <div class="totals-section">
        <div class="total-row" style="font-size:9px;color:#333;">
            <span class="total-label">${totalItems} item${totalItems !== 1 ? "s" : ""} &bull; ${formatQty(
				snapshot.total_qty,
			)} unit${snapshot.total_qty !== 1 ? "s" : ""}</span>
        </div>
        <div class="total-row">
            <span class="total-label">Subtotal</span>
            <span class="total-value">${money(snapshot.subtotal)}</span>
        </div>
        ${discountRow}
        ${netTotalRow}
        ${taxesHtml}
        <hr class="div-solid">
        <div class="total-row highlight">
            <span class="total-label">${isReturn ? "REFUND" : "TOTAL"}</span>
            <span class="total-value">${money(Math.abs(snapshot.grand_total))}</span>
        </div>
    </div>

    ${paymentsHtml}

    ${
		snapshot.notes
			? `<hr class="div-dashed">
    <div style="font-size:9px;color:#000;padding:2px 0;"><strong>Notes:</strong> ${esc(snapshot.notes)}</div>`
			: ""
	}

    <div class="barcode-section">
        <span class="invoice-barcode">${esc(snapshot.name)}</span>
    </div>

    <div class="receipt-footer">
        ${
			isReturn
				? '<div class="thank-you">Refund Processed</div>'
				: '<div class="thank-you">Thank You!</div>'
		}
        ${ctx.receipt_footer ? `<div class="receipt-footer-html">${ctx.receipt_footer}</div>` : ""}
        <div class="powered-by">Powered by XPOS &bull; ${new Date().getFullYear()}</div>
    </div>
</div>`;
}

/** A slip carrying the full code of each card just sold, printed once at the till. */
export function buildGiftCardSlipHtml(cards: IssuedGiftCard[]): string {
	const blocks = cards
		.map(
			(card) => `
		<div class="card">
			<div class="title">${esc(__("Gift Card"))}</div>
			<div class="code">${esc(card.code)}</div>
			<div class="value">${esc(fmtMoney(card.amount, card.currency))}</div>
			${card.valid_upto ? `<div class="small">${esc(__("Valid until {0}", [fmtDate(card.valid_upto)]))}</div>` : ""}
			<div class="small">${esc(__("Anyone holding this code can spend it. Keep it safe."))}</div>
		</div>`,
		)
		.join("");
	return `<!doctype html><html><head><meta charset="utf-8"><style>
		body { font-family: monospace; width: 72mm; margin: 0 auto; }
		.card { text-align: center; padding: 8px 0; border-bottom: 1px dashed #000; }
		.title { font-weight: bold; }
		.code { font-size: 18px; font-weight: bold; letter-spacing: 2px; margin: 6px 0; }
		.value { font-size: 16px; }
		.small { font-size: 11px; margin-top: 4px; }
	</style></head><body>${blocks}</body></html>`;
}
