export interface SessionScope {
	user: string;
	profile: string;
	company: string;
	warehouse: string;
	priceList: string;
}

export interface SaleOwner {
	user: string;
	profile: string;
	company: string;
}

let current: SessionScope | null = null;

export function setSessionScope(scope: SessionScope | null): void {
	current = scope;
}

export function getSessionScope(): SessionScope | null {
	return current;
}

export function scopeKey(scope: SessionScope | null = current): string {
	if (!scope) return "";
	const host = typeof location !== "undefined" ? location.host : "";
	return [host, scope.user, scope.company, scope.profile, scope.warehouse, scope.priceList].join("|");
}

export function currentOwner(): SaleOwner | null {
	return current ? { user: current.user, profile: current.profile, company: current.company } : null;
}
