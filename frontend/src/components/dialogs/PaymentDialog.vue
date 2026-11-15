<template>
	<Dialog
		:open="cartStore.showPaymentDialog"
		@update:open="
			(val: boolean) => {
				if (!val) close();
			}
		"
	>
		<DialogContent class="flex h-[calc(100dvh-2rem)] max-w-5xl flex-col gap-0 p-0" :hide-close="true">
			<DialogHeader
				class="shrink-0 flex-row items-center justify-between gap-3 space-y-0 border-b border-border px-5 py-3"
			>
				<div class="flex min-w-0 items-center gap-3">
					<div
						class="flex size-9 shrink-0 items-center justify-center rounded-xl text-primary-foreground shadow-raised"
						:class="cartStore.isReturnMode ? 'bg-warning text-warning-foreground' : 'bg-primary'"
					>
						<RotateCcw v-if="cartStore.isReturnMode" class="size-4.5" />
						<Wallet v-else class="size-4.5" />
					</div>
					<div class="min-w-0">
						<DialogTitle class="text-base">
							{{ cartStore.isReturnMode ? __("Return Payment") : __("Payment") }}
						</DialogTitle>
						<DialogDescription class="truncate text-xs">{{
							cartStore.customerName
						}}</DialogDescription>
					</div>
				</div>
				<div class="flex shrink-0 items-center gap-2">
					<div
						v-if="customerBalance !== null && !cartStore.isReturnMode"
						class="hidden items-center gap-1.5 sm:flex"
					>
						<Badge v-if="customerBalance > 0" variant="warning" size="sm">
							{{ __("Outstanding") }}: {{ money(customerBalance) }}
						</Badge>
						<Badge v-if="customerCreditLimit > 0" variant="info" size="sm">
							{{ __("Credit Limit") }}: {{ money(customerCreditLimit) }}
						</Badge>
					</div>
					<Badge v-if="cartStore.isReturnMode" variant="warning" size="sm">
						<RotateCcw class="size-3" /> {{ __("Return") }}
					</Badge>
					<Badge
						v-if="!offlineStore.isOnline"
						variant="warning"
						size="sm"
						data-testid="payment-offline"
					>
						<WifiOff class="size-3" /> {{ __("Offline") }}
					</Badge>
					<div
						v-if="offlineBlockerMessages.length"
						class="basis-full text-xs text-destructive whitespace-pre-line"
						role="alert"
						data-testid="payment-offline-blockers"
					>
						{{ offlineBlockerMessages.join("\n") }}
					</div>
					<Button
						variant="ghost"
						size="icon-sm"
						tabindex="-1"
						:aria-label="__('Close')"
						:disabled="isSubmitting"
						@click="close"
					>
						<X class="size-5" />
					</Button>
				</div>
			</DialogHeader>

			<div class="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
				<div class="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-4 xpos-scrollbar">
					<section
						class="rounded-2xl border px-4 py-3"
						:class="
							cartStore.isReturnMode
								? 'border-warning/30 bg-warning-soft'
								: 'border-primary/20 bg-surface-selected'
						"
						data-testid="amount-due"
					>
						<div class="flex items-end justify-between gap-3">
							<div class="min-w-0">
								<p
									class="text-xs font-semibold uppercase tracking-wider"
									:class="
										cartStore.isReturnMode
											? 'text-warning-soft-foreground'
											: 'text-primary'
									"
								>
									{{ cartStore.isReturnMode ? __("Refund Amount") : __("Amount Due") }}
								</p>
								<p
									class="text-4xl font-extrabold tracking-tight tabular-nums"
									:class="
										cartStore.isReturnMode
											? 'text-warning-soft-foreground'
											: 'text-primary dark:text-focus'
									"
								>
									{{ money(Math.abs(cartStore.grandTotal)) }}
								</p>
							</div>
							<Button
								variant="ghost"
								size="sm"
								class="shrink-0"
								:aria-expanded="showBreakdown"
								aria-controls="payment-breakdown"
								@click="showBreakdown = !showBreakdown"
							>
								{{ showBreakdown ? __("Hide details") : __("Details") }}
								<ChevronDown
									class="size-4 transition-transform"
									:class="showBreakdown && 'rotate-180'"
								/>
							</Button>
						</div>
						<dl
							v-show="showBreakdown"
							id="payment-breakdown"
							class="mt-2 space-y-0.5 border-t border-border/60 pt-2 text-xs text-muted-foreground"
						>
							<div class="flex justify-between">
								<dt>{{ __("Subtotal") }}</dt>
								<dd class="tabular-nums">{{ money(cartStore.subtotal) }}</dd>
							</div>
							<div
								v-for="(tax, idx) in cartStore.calculatedTaxes"
								:key="idx"
								class="flex justify-between"
							>
								<dt class="flex items-center gap-1">
									{{ tax.description }}
									<span v-if="tax.rate">({{ percent(tax.rate) }})</span>
									<span
										v-if="tax.included_in_print_rate"
										class="font-semibold uppercase text-info-soft-foreground"
										>{{ __("incl.") }}</span
									>
								</dt>
								<dd
									class="tabular-nums"
									:class="tax.included_in_print_rate && 'text-info-soft-foreground'"
								>
									{{ formatTaxAmount(tax.amount, tax.included_in_print_rate, money) }}
								</dd>
							</div>
							<div
								v-if="cartStore.offerItemDiscountTotal > 0"
								class="flex justify-between text-success-soft-foreground"
							>
								<dt>{{ __("Offer Discount") }}</dt>
								<dd class="tabular-nums">-{{ money(cartStore.offerItemDiscountTotal) }}</dd>
							</div>
							<div
								v-if="cartStore.offerGrandTotalDiscountPct > 0"
								class="flex justify-between text-success-soft-foreground"
							>
								<dt>
									{{ __("Offer") }} ({{ percent(cartStore.offerGrandTotalDiscountPct) }})
								</dt>
								<dd class="tabular-nums">-{{ money(paymentOfferGrandDiscount) }}</dd>
							</div>
							<div v-if="cartStore.appliedCoupon" class="flex justify-between">
								<dt>
									{{ __("Coupon") }}:
									{{ cartStore.appliedCoupon.coupon_code || cartStore.appliedCoupon.name }}
								</dt>
								<dd>{{ __("Applied") }}</dd>
							</div>
							<div
								v-if="cartStore.redeemLoyaltyPoints && cartStore.loyaltyAmount > 0"
								class="flex justify-between"
							>
								<dt>{{ __("Loyalty") }}</dt>
								<dd class="tabular-nums">-{{ money(cartStore.loyaltyAmount) }}</dd>
							</div>
							<div v-if="cartStore.depositApplied > 0" class="flex justify-between">
								<dt>{{ __("Deposit on {0}", [cartStore.sourceOrder?.name || ""]) }}</dt>
								<dd class="tabular-nums">-{{ money(cartStore.depositApplied) }}</dd>
							</div>
							<div
								v-if="Math.abs(cartStore.roundingAdjustment) >= 0.005"
								class="flex justify-between"
							>
								<dt>{{ __("Rounding") }}</dt>
								<dd class="tabular-nums">
									{{ cartStore.roundingAdjustment > 0 ? "+" : "-"
									}}{{ money(Math.abs(cartStore.roundingAdjustment)) }}
								</dd>
							</div>
						</dl>
					</section>

					<section>
						<div class="mb-2 flex items-center justify-between">
							<h3 class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
								{{ __("Method") }}
							</h3>
							<span class="text-[0.6875rem] text-muted-foreground" aria-hidden="true"
								>&larr; &rarr;</span
							>
						</div>
						<div
							class="grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-2"
							role="radiogroup"
							:aria-label="__('Payment method')"
						>
							<button
								v-for="(method, idx) in availableMethods"
								:key="method.mode_of_payment"
								:ref="
									(el) => {
										if (el) methodRefs[idx] = el as HTMLButtonElement;
									}
								"
								type="button"
								role="radio"
								:aria-checked="selectedMethod === method.mode_of_payment"
								data-testid="payment-method"
								:data-mode="method.mode_of_payment"
								@click="selectMethod(method.mode_of_payment)"
								@keydown.left.prevent="focusMethod(idx - 1)"
								@keydown.right.prevent="focusMethod(idx + 1)"
								@keydown.down.prevent="focusAmountInput"
								class="flex h-16 flex-col items-center justify-center gap-1 rounded-xl border-2 px-2 text-center transition-[border-color,background-color,box-shadow] duration-fast focus:outline-none focus-visible:ring-2 focus-visible:ring-focus active:shadow-pressed"
								:class="
									selectedMethod === method.mode_of_payment
										? 'border-primary bg-surface-selected text-surface-selected-foreground shadow-raised'
										: 'border-border bg-surface-raised text-muted-foreground shadow-raised hover:bg-surface-hover'
								"
							>
								<component :is="getMethodIcon(method.mode_of_payment)" class="size-5" />
								<span class="w-full truncate text-xs font-semibold">{{
									method.mode_of_payment
								}}</span>
							</button>
						</div>
					</section>

					<section class="space-y-2">
						<div class="flex items-center justify-between">
							<label
								class="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
								for="payment-tendered"
							>
								{{ isSplitPayment ? __("Amount for {0}", [selectedMethod]) : __("Tendered") }}
							</label>
							<Button
								v-if="!isSplitPayment"
								variant="link"
								size="sm"
								class="h-auto p-0 text-xs"
								data-testid="split-payment"
								@click="enableSplitPayment"
							>
								{{ __("Split Payment") }}
							</Button>
						</div>
						<NumberInput
							id="payment-tendered"
							ref="amountInput"
							v-model="tenderedAmount"
							:min="0"
							:precision="selectedPrecision"
							class="h-14 text-center text-2xl font-bold tracking-wider"
							:select-on-focus="true"
							@keydown.enter.stop.prevent="handleAmountInputSubmit"
							@keydown.up.prevent="focusMethodByIndex"
							@keydown.down.prevent="focusFirstQuickAmount"
						/>

						<div v-if="selectedTakesReference" data-testid="payment-reference">
							<input
								ref="referenceRef"
								v-model="referenceNo"
								autocomplete="off"
								maxlength="140"
								:aria-label="__('Reference number')"
								class="h-control w-full rounded-xl border bg-card px-3 font-mono text-sm shadow-inset focus:outline-none focus:ring-4 focus:ring-primary/12"
								:class="
									referenceMissing && tenderedAmount > 0
										? 'border-warning'
										: 'border-border'
								"
								:placeholder="
									selectedNeedsReference
										? __('Transfer / reference number (required)')
										: __('Transfer / reference number')
								"
								@keydown.enter.stop.prevent="handleAmountInputSubmit"
							/>
						</div>

						<div v-if="selectedIsForeign" class="mt-1.5 space-y-1">
							<p v-if="selectedRateMissing" class="text-xs font-medium text-destructive">
								{{
									__("No exchange rate for {0}. Set today's rate before accepting it.", [
										selectedCurrency,
									])
								}}
							</p>
							<template v-else>
								<p class="text-xs text-muted-foreground">
									{{ formatWithSymbol(selectedCurrency, tenderedAmount) }}
									{{ __("at") }} {{ formatFor(invoiceCurrency, selectedRate) }} =
									<span class="font-semibold text-foreground">
										{{
											formatWithSymbol(
												invoiceCurrency,
												convertToBase(
													selectedCurrency,
													invoiceCurrency,
													tenderedAmount,
													selectedRate,
												),
											)
										}}
									</span>
								</p>
								<p
									:class="
										selectedRateIsStale
											? 'text-xs font-medium text-warning-soft-foreground'
											: 'text-xs text-muted-foreground'
									"
								>
									{{
										selectedRateIsStale
											? __("Rate is from {0} and has not been updated today.", [
													selectedRateDate,
												])
											: __("Rate as of {0}", [selectedRateDate])
									}}
								</p>
							</template>
						</div>

						<div v-if="!isSplitPayment" class="grid grid-cols-2 sm:grid-cols-4 gap-2">
							<Button
								v-for="(amount, idx) in quickAmounts"
								:key="amount"
								:ref="
									(el) => {
										if (el) quickAmountRefs[idx] = (el as any).$el || el;
									}
								"
								variant="outline"
								class="h-11 font-semibold tabular-nums"
								@click="setQuickAmount(amount)"
								@keydown.enter.prevent="setQuickAmount(amount)"
								@keydown.up.prevent="focusAmountInput"
								@keydown.down.prevent="focusSubmitBtn"
								@keydown.left.prevent="focusQuickAmount(idx - 1)"
								@keydown.right.prevent="focusQuickAmount(idx + 1)"
							>
								{{ money(amount) }}
							</Button>
						</div>
						<Button
							v-else
							variant="outline"
							class="w-full"
							data-testid="add-tender-leg"
							:disabled="!selectedMethod || tenderedAmount <= 0 || referenceMissing"
							@click="addSplitPayment"
						>
							<Plus class="size-4" />
							{{ __("Add {0}", [selectedMethod]) }} &mdash;
							{{ formatWithSymbol(selectedCurrency, tenderedAmount) }}
						</Button>
					</section>

					<section v-if="activeLegs.length" class="space-y-1.5" data-testid="tender-allocation">
						<h3 class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
							{{ __("Payments") }}
						</h3>
						<ul class="divide-y divide-border rounded-xl border border-border bg-surface-raised">
							<li
								v-for="(sp, idx) in activeLegs"
								:key="sp.id || idx"
								class="flex items-center justify-between gap-2 px-3 py-2 text-sm"
								data-testid="tender-leg"
								:data-mode="sp.mode_of_payment"
							>
								<div class="flex min-w-0 items-center gap-2">
									<component
										:is="getMethodIcon(sp.mode_of_payment)"
										class="size-4.5 shrink-0 text-muted-foreground"
									/>
									<span class="truncate font-medium text-foreground">{{
										sp.mode_of_payment
									}}</span>
									<span
										v-if="sp.masked_code"
										class="font-mono text-xs text-muted-foreground"
										>{{ sp.masked_code }}</span
									>
									<span
										v-if="sp.reference_no"
										class="truncate font-mono text-xs text-muted-foreground"
										>{{ sp.reference_no }}</span
									>
								</div>
								<div class="flex shrink-0 items-center gap-2">
									<div class="text-end">
										<span class="font-bold text-foreground tabular-nums">
											{{ formatWithSymbol(sp.currency, sp.native_amount) }}
										</span>
										<span
											v-if="sp.currency !== invoiceCurrency"
											class="block text-xs text-muted-foreground tabular-nums"
										>
											@ {{ formatFor(invoiceCurrency, sp.exchange_rate) }} =
											{{ formatWithSymbol(invoiceCurrency, sp.base_amount) }}
										</span>
									</div>
									<button
										v-if="isSplitPayment"
										type="button"
										class="rounded-md p-1 text-muted-foreground hover:bg-surface-hover hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
										:aria-label="__('Remove {0} payment', [sp.mode_of_payment])"
										@click="removeSplitPayment(idx)"
									>
										<X class="size-3.5" />
									</button>
								</div>
							</li>
						</ul>
						<div v-if="hasForeignTender" class="space-y-0.5 px-3">
							<div
								v-for="group in tenderByCurrency"
								:key="group.currency"
								class="flex justify-between text-xs text-muted-foreground tabular-nums"
							>
								<span>{{ formatWithSymbol(group.currency, group.native) }}</span>
								<span>{{ formatWithSymbol(invoiceCurrency, group.base) }}</span>
							</div>
						</div>
					</section>

					<section v-if="hasOtherTenders" class="space-y-3" data-testid="other-tenders">
						<h3 class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
							{{ __("Other tenders") }}
						</h3>
						<div v-if="canRedeemGiftCards" data-testid="gift-card-tender">
							<p v-if="!offlineStore.isOnline" class="text-xs text-muted-foreground">
								{{ __("Gift cards need a live connection.") }}
							</p>
							<div v-else-if="showGiftInput" class="flex gap-2">
								<input
									ref="giftCodeRef"
									v-model="giftCodeInput"
									data-testid="gift-card-code"
									autocomplete="off"
									class="h-control min-w-0 flex-1 rounded-xl border border-border bg-card px-3 font-mono text-sm uppercase shadow-inset focus:outline-none focus:ring-4 focus:ring-primary/12"
									:placeholder="__('Gift card code')"
									@keydown.enter.stop.prevent="applyGiftCard"
									@keydown.esc.stop.prevent="showGiftInput = false"
								/>
								<Button
									size="sm"
									:disabled="checkingGift || !giftCodeInput.trim()"
									@click="applyGiftCard"
								>
									<Loader2 v-if="checkingGift" class="w-4 h-4 animate-spin" />
									{{ __("Apply") }}
								</Button>
							</div>
							<Button v-else variant="outline" size="sm" class="w-full" @click="openGiftInput">
								<Gift class="w-4 h-4" />
								{{ __("Pay with Gift Card") }}
							</Button>
						</div>
						<div
							v-if="
								cartStore.isReturnMode &&
								posStore.giftCardMode &&
								cartStore.returnGiftCards.length
							"
							class="space-y-1"
						>
							<Button
								v-for="card in cartStore.returnGiftCards"
								:key="card.gift_card"
								variant="outline"
								size="sm"
								class="w-full"
								:disabled="
									!offlineStore.isOnline ||
									splitPayments.some((leg) => leg.gift_card === card.gift_card)
								"
								@click="refundToGiftCard(card)"
							>
								<Gift class="w-4 h-4" />
								{{
									__("Refund to gift card {0} (up to {1})", [
										card.masked_code,
										money(card.amount),
									])
								}}
							</Button>
						</div>
						<div
							v-if="showCustomerCredit"
							class="space-y-2 rounded-xl border border-border bg-surface-raised p-3"
							data-testid="customer-credit"
						>
							<div class="flex items-center justify-between">
								<span class="text-sm font-medium text-foreground">{{
									__("Customer Credit")
								}}</span>
								<Badge variant="neutral" size="sm">
									{{ __("Available") }}: {{ money(availableCreditTotal) }}
								</Badge>
							</div>
							<div
								v-for="source in creditSources"
								:key="creditKey(source)"
								class="flex items-center justify-between gap-2 text-xs"
							>
								<span class="min-w-0 truncate">
									{{
										source.source_type === "Payment Entry"
											? __("Advance payment")
											: __("Credit note")
									}}
									{{ source.source_name }}
									<span class="text-muted-foreground">({{ money(source.available) }})</span>
								</span>
								<NumberInput
									v-model="creditAllocations[creditKey(source)]"
									:min="0"
									:max="source.available"
									:precision="precisionFor(invoiceCurrency)"
									class="w-24 text-end text-sm"
									:aria-label="__('Credit to use from {0}', [source.source_name])"
								/>
							</div>
							<p
								v-if="creditApplied > 0"
								class="text-xs font-medium text-success-soft-foreground"
							>
								{{ __("Using {0} of customer credit", [money(creditApplied)]) }}
							</p>
						</div>
						<div
							v-if="cartStore.customer && !cartStore.isReturnMode && customerLoyaltyPoints > 0"
							class="space-y-2 rounded-xl border border-border bg-surface-raised p-3"
						>
							<div class="flex items-center justify-between">
								<div class="flex items-center gap-2">
									<Gift class="size-4 text-primary" />
									<span class="text-sm font-medium text-foreground">{{
										__("Loyalty Points")
									}}</span>
								</div>
								<Badge variant="neutral" size="sm">
									{{ customerLoyaltyPoints }} {{ __("pts") }} ({{
										money(customerLoyaltyAmount)
									}})
								</Badge>
							</div>

							<template v-if="cartStore.redeemLoyaltyPoints">
								<div class="flex items-center justify-between text-xs">
									<span class="font-medium text-foreground">
										{{ __("Redeeming") }}: {{ cartStore.loyaltyPoints }} {{ __("pts") }} =
										{{ money(cartStore.loyaltyAmount) }}
									</span>
									<Button
										variant="ghost"
										size="sm"
										class="h-7 px-2 text-xs text-destructive-soft-foreground"
										@click="
											cartStore.clearLoyalty();
											showLoyaltyInput = false;
										"
									>
										{{ __("Remove") }}
									</Button>
								</div>
							</template>

							<template v-else-if="showLoyaltyInput">
								<div class="space-y-1.5">
									<div class="flex items-center gap-1.5">
										<NumberInput
											v-model="redeemPointsInput"
											:min="1"
											:max="maxRedeemablePoints"
											:precision="0"
											class="flex-1 text-sm"
										/>
										<span class="text-xs text-muted-foreground shrink-0"
											>/ {{ maxRedeemablePoints }} {{ __("pts") }}</span
										>
									</div>
									<p class="text-xs text-muted-foreground">
										{{ __("Discount") }}: {{ money(redeemInputAmount) }}
									</p>
									<div class="flex gap-1.5">
										<Button
											variant="default"
											size="sm"
											class="flex-1"
											:disabled="redeemPointsInput < 1"
											@click="applyLoyalty"
										>
											{{ __("Apply") }}
										</Button>
										<Button
											variant="outline"
											size="sm"
											class="flex-1 text-xs"
											@click="cancelLoyaltyInput"
										>
											{{ __("Cancel") }}
										</Button>
									</div>
								</div>
							</template>

							<template v-else>
								<Button variant="outline" size="sm" class="w-full" @click="openLoyaltyInput">
									<Gift class="w-3 h-3" />
									{{ __("Redeem Points") }}
								</Button>
							</template>
						</div>
						<div v-if="posStore.allowWriteOffChange && !cartStore.isReturnMode" class="space-y-1">
							<div class="flex items-center justify-between">
								<label
									class="text-xs font-semibold text-muted-foreground uppercase tracking-wider"
								>
									{{ __("Write Off") }}
								</label>
								<span class="text-xs text-muted-foreground">{{
									__("Small remaining amounts")
								}}</span>
							</div>
							<NumberInput
								v-model="writeOffInput"
								:min="0"
								:precision="moneyPrecision"
								placeholder="0.00"
								class="text-sm"
								@change="cartStore.writeOffAmount = writeOffInput || 0"
							/>
						</div>
					</section>

					<div class="space-y-1">
						<div class="flex items-center justify-between">
							<label
								class="text-xs font-semibold text-muted-foreground uppercase tracking-wider"
							>
								{{ __("Posting Date") }}
							</label>
							<span
								v-if="!posStore.allowChangePostingDate"
								class="text-xs text-muted-foreground"
							>
								{{ __("Locked by POS Profile") }}
							</span>
						</div>
						<DateTimePicker
							v-model="cartStore.postingDate"
							mode="date"
							:disabled="!posStore.allowChangePostingDate"
							:clearable="false"
							placeholder="Posting date"
							class="text-sm"
						/>
					</div>
				</div>

				<aside
					class="flex shrink-0 flex-col gap-3 border-t border-border p-4 lg:w-80 lg:border-s lg:border-t-0"
				>
					<div
						class="rounded-2xl border border-border bg-surface-raised p-3 shadow-raised"
						data-testid="payment-balance"
					>
						<dl class="space-y-1 text-sm">
							<div class="flex justify-between">
								<dt class="text-muted-foreground">
									{{ cartStore.isReturnMode ? __("Refund") : __("Due") }}
								</dt>
								<dd class="font-semibold tabular-nums">
									{{ money(Math.abs(cartStore.grandTotal)) }}
								</dd>
							</div>
							<div v-if="creditApplied > 0" class="flex justify-between">
								<dt class="text-muted-foreground">{{ __("Customer credit") }}</dt>
								<dd class="font-semibold tabular-nums">-{{ money(creditApplied) }}</dd>
							</div>
							<div class="flex justify-between">
								<dt class="text-muted-foreground">
									{{ cartStore.isReturnMode ? __("Refunding") : __("Tendered") }}
								</dt>
								<dd class="font-semibold tabular-nums" data-testid="payment-tendered-total">
									{{ formatWithSymbol(invoiceCurrency, effectiveTendered) }}
								</dd>
							</div>
						</dl>
						<div
							class="mt-2 rounded-xl px-3 py-2"
							:class="
								remainingAmount > 0
									? 'bg-warning-soft text-warning-soft-foreground'
									: changeAmount > 0
										? 'bg-success-soft text-success-soft-foreground'
										: 'bg-surface-sunken text-foreground'
							"
							data-testid="payment-remaining"
						>
							<p class="text-xs font-semibold">
								{{
									remainingAmount > 0
										? remainingLabel
										: changeAmount > 0
											? __("Change")
											: __("Balance")
								}}
							</p>
							<p class="text-2xl font-extrabold tabular-nums">
								<template v-if="remainingAmount > 0">{{ money(remainingAmount) }}</template>
								<template v-else-if="changeAmount > 0">{{
									formatWithSymbol(invoiceCurrency, changeAmount)
								}}</template>
								<template v-else>{{ money(0) }}</template>
							</p>
							<p v-if="outstandingSubmissionHint" class="mt-0.5 text-xs font-medium">
								{{ outstandingSubmissionHint }}
							</p>
						</div>
					</div>

					<div
						v-if="showChangeAllocator"
						class="space-y-2 rounded-xl border border-success/25 bg-success-soft p-3"
					>
						<div class="flex items-center justify-between">
							<p class="text-xs font-semibold text-success-soft-foreground">
								{{ __("Change") }}
							</p>
							<p class="text-lg font-extrabold text-success-soft-foreground tabular-nums">
								{{ formatWithSymbol(invoiceCurrency, changeAmount) }}
							</p>
						</div>

						<div
							v-for="(leg, idx) in changeLegs"
							:key="`${leg.mode_of_payment}-${idx}`"
							data-testid="change-leg"
							:data-mode="leg.mode_of_payment"
							:data-currency="leg.currency"
						>
							<div class="flex items-center gap-2">
								<component
									:is="getMethodIcon(leg.mode_of_payment)"
									class="w-4 h-4 shrink-0"
								/>
								<span class="text-xs font-medium text-foreground truncate flex-1">
									{{ leg.mode_of_payment }}
								</span>
								<NumberInput
									:model-value="leg.amount"
									:min="0"
									:precision="precisionFor(leg.currency)"
									class="w-28 text-end text-sm py-1"
									data-testid="change-leg-input"
									@update:model-value="updateChangeLeg(idx, Number($event) || 0)"
								/>
								<button
									v-if="changeLegs.length > 1"
									@click="removeChangeLeg(idx)"
									class="text-muted-foreground hover:text-destructive"
								>
									<X class="w-3.5 h-3.5" />
								</button>
							</div>
							<p
								v-if="leg.currency !== invoiceCurrency"
								class="ps-6 text-[0.6875rem] text-muted-foreground"
							>
								@ {{ formatFor(invoiceCurrency, leg.exchange_rate) }} =
								{{ formatWithSymbol(invoiceCurrency, leg.base_amount) }}
							</p>
						</div>

						<div class="flex flex-wrap gap-1">
							<Button
								v-for="mode in posStore.cashTenderModes"
								:key="mode.mode_of_payment"
								variant="outline"
								size="sm"
								class="text-xs h-7"
								data-testid="add-change-leg"
								:data-mode="mode.mode_of_payment"
								:disabled="changeRemaining <= 0"
								@click="addChangeLeg(mode.mode_of_payment)"
							>
								<Plus class="w-3 h-3" />
								{{ mode.mode_of_payment }}
								<span v-if="changeRemaining > 0" class="text-muted-foreground">
									{{
										formatWithSymbol(
											mode.pos_tender_currency,
											changeRemainingIn(mode.pos_tender_currency),
										)
									}}
								</span>
							</Button>
						</div>

						<p
							v-if="!changeAllocationValid"
							class="text-xs font-medium text-destructive tabular-nums"
						>
							{{
								__("{0} of change is still unallocated", [
									formatWithSymbol(invoiceCurrency, changeRemaining),
								])
							}}
						</p>
					</div>

					<div class="hidden flex-1 flex-col gap-2 lg:flex">
						<h3 class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
							{{ __("Numpad") }}
						</h3>
						<div class="grid grid-cols-3 gap-2">
							<Button
								v-for="(key, idx) in numpadKeys"
								:key="key"
								:ref="
									(el) => {
										if (el) numpadRefs[idx] = (el as any).$el || el;
									}
								"
								:variant="key === '⌫' || key === 'C' ? 'secondary' : 'outline'"
								class="h-12 text-lg font-semibold tabular-nums data-[pressed=true]:translate-y-px data-[pressed=true]:border-primary data-[pressed=true]:bg-surface-pressed data-[pressed=true]:shadow-pressed"
								:data-pressed="pressedKey === key || undefined"
								data-testid="numpad-key"
								:data-key="key"
								:aria-label="
									key === '⌫'
										? __('Backspace')
										: key === 'C'
											? __('Clear amount')
											: undefined
								"
								@click="handleNumpad(key)"
								@keydown.enter.prevent="handleNumpad(key)"
							>
								<Delete v-if="key === '⌫'" class="size-5" />
								<template v-else>{{ key }}</template>
							</Button>
						</div>
					</div>
				</aside>
			</div>

			<DialogFooter
				class="shrink-0 items-center justify-between gap-3 rounded-b-[calc(1.5rem-1px)] border-t border-border bg-surface-sunken px-5 py-3 sm:justify-between"
			>
				<div
					class="min-w-0 flex-1"
					aria-live="polite"
					data-testid="payment-status"
					:data-state="submitState"
				>
					<p
						v-if="submitState !== 'idle'"
						class="flex items-center gap-2 text-sm font-medium"
						:class="
							submitState === 'failed' || submitState === 'retry'
								? 'text-destructive-soft-foreground'
								: 'text-foreground'
						"
					>
						<Loader2
							v-if="submitState === 'checking' || submitState === 'saving'"
							class="size-4 shrink-0 animate-spin"
						/>
						<AlertTriangle v-else class="size-4 shrink-0" />
						<span class="min-w-0">{{ submitMessage }}</span>
					</p>
					<div
						v-else
						class="hidden items-center gap-2 text-[0.6875rem] text-muted-foreground sm:flex"
					>
						<kbd class="rounded border border-border bg-muted px-1.5 py-0.5 font-mono">Enter</kbd>
						<span>{{ __("Save & Print") }}</span>
						<kbd class="ms-2 rounded border border-border bg-muted px-1.5 py-0.5 font-mono"
							>Ctrl+Enter</kbd
						>
						<span>{{ __("Save Only") }}</span>
						<kbd class="ms-2 rounded border border-border bg-muted px-1.5 py-0.5 font-mono"
							>Esc</kbd
						>
						<span>{{ __("Cancel") }}</span>
					</div>
				</div>
				<div class="flex shrink-0 items-center gap-2">
					<Button variant="outline" tabindex="-1" :disabled="isSubmitting" @click="close">{{
						__("Cancel")
					}}</Button>
					<Button
						variant="outline"
						class="font-semibold"
						data-testid="save-payment"
						:disabled="isSubmitting || !canSubmit"
						@click="submitPayment(false)"
					>
						<Loader2 v-if="isSubmitting && !printAfterSave" class="size-4 animate-spin" />
						<Save v-else class="size-4" />
						{{ __("Save Only") }}
					</Button>
					<Button
						ref="submitBtn"
						class="h-12 min-w-44 rounded-xl px-5 text-base font-bold shadow-primary transition-[transform,box-shadow,background-color] duration-fast active:translate-y-px active:shadow-pressed"
						:class="
							cartStore.isReturnMode &&
							'border-warning bg-warning text-warning-foreground shadow-raised hover:bg-warning/90'
						"
						data-testid="save-print-payment"
						:disabled="isSubmitting || !canSubmit"
						@click="submitPayment(true)"
					>
						<template v-if="isSubmitting && printAfterSave">
							<Loader2 class="size-4 animate-spin" />
							{{ __("Saving...") }}
						</template>
						<template v-else>
							<Printer class="size-4" />
							{{ cartStore.isReturnMode ? __("Return & Print") : __("Save & Print") }}
						</template>
					</Button>
				</div>
			</DialogFooter>
		</DialogContent>
	</Dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from "vue";
import { usePosStore } from "@/stores/posStore";
import { useMoney } from "@/composables/useMoney";
import { useCartStore } from "@/stores/cartStore";
import { useCartSessionStore } from "@/stores/cartSessionStore";
import { useCustomerStore } from "@/stores/customerStore";
import { useAuthStore } from "@/stores/authStore";
import { usePaymentStore } from "@/stores/paymentStore";
import { call, showSuccess, showError, showInfo, isNetworkError } from "@/services/api";
import { __ } from "@/lib/translate";
import { usePrintInvoice } from "@/composables/usePrintInvoice";
import { submitDurableInvoice } from "@/services/invoiceSubmission";
import { captureSaleOrigin, useOfflineSale, type SaleOrigin } from "@/composables/useOfflineSale";
import { offlineSaleBlockers } from "@/services/offlinePolicy";
import {
	completeLocalFiscalization,
	FiscalUncertainError,
	LocalFiscalRejected,
} from "@/services/fbrLocalService";
import { addPendingInvoice } from "@/services/dbBridge";
import { checkGiftCard, hasGiftCardActivity } from "@/services/giftCards";
import { hasPermission } from "@/services/userRights";
import { useOfflineStore } from "@/stores/offlineStore";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { DateTimePicker } from "@/components/ui/datetime-picker";
import { NumberInput } from "@/components/ui/number-input";
import { Badge } from "@/components/ui/badge";
import {
	Wallet,
	X,
	Check,
	Loader2,
	Delete,
	Gift,
	RotateCcw,
	Plus,
	Save,
	Printer,
	Banknote,
	CreditCard,
	Landmark,
	Smartphone,
	FileText,
	DollarSign,
	ChevronDown,
	WifiOff,
	AlertTriangle,
} from "lucide-vue-next";

import {
	convertToBase,
	formatFor,
	formatWithSymbol,
	precisionFor,
	roundFor,
} from "@/composables/useCurrency";
import {
	buildChangeLeg,
	buildTenderLeg,
	changeBaseTotal,
	changeRemaining as remainingChange,
	groupTenderByCurrency,
	isChangeAllocationValid,
	mergeTenderLeg,
	negateForReturn,
	remainingIn,
	tenderBaseTotal,
	toInvoicePayments,
	type TenderContext,
} from "@/services/tenderLegs";
import type {
	CustomerCreditSource,
	GiftCardRefund,
	InvoiceChangeLeg,
	InvoiceData,
	InvoicePayment,
	IssuedGiftCard,
	RepriceResponse,
	TenderLeg,
} from "@/types/pos.types";
import { isOnline, extractErrorMessage, isTabConflictError } from "@/utils";
import { nowDate } from "@/utils/datetime";
import { formatTaxAmount } from "@/utils/numberFormat";
import {
	isPaymentDialogSaveAndPrintShortcut,
	isPaymentDialogSaveOnlyShortcut,
} from "@/components/dialogs/paymentDialogShortcuts";

const posStore = usePosStore();
const { moneyPrecision, percent } = useMoney();
const { printInvoice } = usePrintInvoice();
const { completeOfflineSale, lastFailure } = useOfflineSale();
const cartStore = useCartStore();
const cartSessions = useCartSessionStore();
const customerStore = useCustomerStore();
const authStore = useAuthStore();
const paymentStore = usePaymentStore();
const offlineStore = useOfflineStore();

const amountInput = ref<InstanceType<typeof NumberInput> | null>(null);
const submitBtn = ref<InstanceType<typeof Button> | null>(null);
const methodRefs: Record<number, HTMLButtonElement> = {};
const quickAmountRefs: Record<number, HTMLElement> = {};
const numpadRefs: Record<number, HTMLElement> = {};

const selectedMethod = ref("");
const tenderedAmount = ref(0);
const creditSources = ref<CustomerCreditSource[]>([]);
const creditAllocations = ref<Record<string, number>>({});

function creditKey(source: CustomerCreditSource): string {
	return `${source.source_type}:${source.source_name}`;
}

const showCustomerCredit = computed(
	() =>
		posStore.useCustomerCredit &&
		!cartStore.isReturnMode &&
		!!cartStore.customer &&
		offlineStore.isOnline &&
		creditSources.value.length > 0,
);

const availableCreditTotal = computed(() => creditSources.value.reduce((sum, s) => sum + s.available, 0));

const creditApplied = computed(() => {
	if (!showCustomerCredit.value) return 0;
	return roundCurrency(
		creditSources.value.reduce(
			(sum, s) => sum + Math.min(Math.max(creditAllocations.value[creditKey(s)] || 0, 0), s.available),
			0,
		),
	);
});

watch(creditApplied, (credit) => {
	if (isSplitPayment.value) return;
	const due = roundCurrency(Math.max(Math.abs(cartStore.grandTotal) - credit, 0));
	tenderedAmount.value = due;
	nextTick(() => amountInput.value?.setValue(due));
});
const isSubmitting = ref(false);
const showBreakdown = ref(false);

/**
 * What the till is doing with this sale, shown in the footer. There is no "done" state here:
 * the dialog closes only once the server, or the local queue, has the sale.
 */
type SubmitState = "idle" | "checking" | "saving" | "retry" | "failed";
const submitState = ref<SubmitState>("idle");
const submitMessage = ref("");

function setSubmitState(state: SubmitState, message = "") {
	submitState.value = state;
	submitMessage.value = message;
}

/** Report a refusal both in the footer and as a toast, as before. */
function failSubmit(message: string, state: SubmitState = "failed") {
	setSubmitState(state, message);
	showError(message);
}
const writeOffInput = ref(0);
const printAfterSave = ref(false);

const isSplitPayment = ref(false);
const splitPayments = ref<TenderLeg[]>([]);

const referenceRef = ref<HTMLInputElement | null>(null);
const referenceNo = ref("");

const changeLegs = ref<InvoiceChangeLeg[]>([]);
const changeTouched = ref(false);

const customerLoyaltyPoints = ref(0);
const customerLoyaltyAmount = ref(0);
const customerConversionFactor = ref(1);
const customerBalance = ref<number | null>(null);
const customerCreditLimit = ref(0);

const showLoyaltyInput = ref(false);
const redeemPointsInput = ref(0);

const numpadKeys = ["7", "8", "9", "4", "5", "6", "1", "2", "3", "C", "0", "⌫"];

const availableMethods = computed(() => {
	// the gift card mode is tendered only through a scanned card, never as a plain amount
	const methods = posStore.paymentMethods.filter((m) => m.mode_of_payment !== posStore.giftCardMode);
	if (methods.length > 0) return methods;
	return [{ mode_of_payment: "Cash" }, { mode_of_payment: "Card" }];
});

const giftCodeRef = ref<HTMLInputElement | null>(null);
const giftCodeInput = ref("");
const showGiftInput = ref(false);
const checkingGift = ref(false);

const canRedeemGiftCards = computed(
	() =>
		!!posStore.giftCardMode &&
		!cartStore.isReturnMode &&
		!cartStore.isGiftCardSale &&
		hasPermission("redeem_gift_card"),
);
const hasGiftCardLegs = computed(() => splitPayments.value.some((leg) => leg.gift_card));
const isGiftCardSale = computed(() => cartStore.isGiftCardSale || hasGiftCardLegs.value);

const hasOtherTenders = computed(
	() =>
		canRedeemGiftCards.value ||
		(cartStore.isReturnMode && !!posStore.giftCardMode && cartStore.returnGiftCards.length > 0) ||
		showCustomerCredit.value ||
		(!!cartStore.customer && !cartStore.isReturnMode && customerLoyaltyPoints.value > 0) ||
		(posStore.allowWriteOffChange && !cartStore.isReturnMode),
);

const quickAmounts = computed(() => {
	const total = Math.abs(cartStore.grandTotal);
	const amounts: number[] = [];
	const rounded = Math.ceil(total);
	amounts.push(rounded);
	amounts.push(Math.ceil(total / 10) * 10);
	amounts.push(Math.ceil(total / 50) * 50);
	amounts.push(Math.ceil(total / 100) * 100);
	return [...new Set(amounts)].sort((a, b) => a - b).slice(0, 4);
});

const invoiceCurrency = computed(() => posStore.invoiceCurrency || posStore.currency || "");

const selectedCurrency = computed(
	() => posStore.tenderCurrencyFor(selectedMethod.value) || invoiceCurrency.value,
);
const selectedRate = computed(() => posStore.tenderRateFor(selectedMethod.value));
const selectedPrecision = computed(() => precisionFor(selectedCurrency.value));
const selectedIsForeign = computed(() => selectedCurrency.value !== invoiceCurrency.value);
const selectedRateDate = computed(() => posStore.tenderModeFor(selectedMethod.value)?.rate_date || "");

const selectedRateIsStale = computed(
	() => selectedIsForeign.value && !!selectedRateDate.value && selectedRateDate.value < nowDate(),
);
const selectedRateMissing = computed(() => selectedIsForeign.value && !selectedRate.value);

const tenderContext = computed<TenderContext>(() => ({
	invoiceCurrency: invoiceCurrency.value,
	modeInfo: (mode: string) => posStore.tenderModeFor(mode),
}));

function buildLeg(mode: string, nativeAmount: number, id?: string): TenderLeg {
	return buildTenderLeg(mode, nativeAmount, tenderContext.value, id);
}

const selectedTakesReference = computed(() => {
	const mode = posStore.tenderModeFor(selectedMethod.value);
	return !!(mode?.takes_reference || mode?.requires_reference);
});
const selectedNeedsReference = computed(
	() => !!posStore.tenderModeFor(selectedMethod.value)?.requires_reference && !cartStore.isReturnMode,
);
const referenceMissing = computed(() => selectedNeedsReference.value && !referenceNo.value.trim());

watch(selectedMethod, () => {
	referenceNo.value = "";
});

function withReference(leg: TenderLeg): TenderLeg {
	const reference = referenceNo.value.trim();
	if (selectedTakesReference.value && reference) leg.reference_no = reference;
	return leg;
}

const activeLegs = computed<TenderLeg[]>(() => {
	if (isSplitPayment.value) return splitPayments.value;
	if (!selectedMethod.value || tenderedAmount.value <= 0) return [];
	return [withReference(buildLeg(selectedMethod.value, tenderedAmount.value, "single"))];
});

const splitTotal = computed(() => tenderBaseTotal(splitPayments.value, invoiceCurrency.value));
const legsBaseTotal = computed(() => tenderBaseTotal(activeLegs.value, invoiceCurrency.value));

const tenderByCurrency = computed(() => groupTenderByCurrency(activeLegs.value, invoiceCurrency.value));

const hasForeignTender = computed(() =>
	activeLegs.value.some((leg) => leg.currency !== invoiceCurrency.value),
);

const maxRedeemablePoints = computed(() => {
	const total = Math.abs(cartStore.grandTotal);
	const conversionFactor = customerConversionFactor.value || 1;
	const maxByTotal = Math.floor(total / conversionFactor);
	return Math.min(customerLoyaltyPoints.value, maxByTotal);
});

const redeemInputAmount = computed(() => {
	return redeemPointsInput.value * (customerConversionFactor.value || 1);
});

const paymentOfferGrandDiscount = computed(() => {
	if (cartStore.offerGrandTotalDiscountPct <= 0) return 0;
	const taxAmt = cartStore.calculatedTaxes
		.filter((t) => !t.included_in_print_rate)
		.reduce((s, t) => s + t.amount, 0);
	const base = cartStore.subtotal + taxAmt - cartStore.offerItemDiscountTotal;
	return (base * cartStore.offerGrandTotalDiscountPct) / 100;
});

const effectiveTendered = computed(() => legsBaseTotal.value);

const changeAmount = computed(() => {
	const total = Math.abs(cartStore.grandTotal) - creditApplied.value;
	const diff = roundCurrency(effectiveTendered.value - total);
	return diff > 0 ? diff : 0;
});

const remainingAmount = computed(() => {
	const total = Math.abs(cartStore.grandTotal);
	const diff = roundCurrency(total - creditApplied.value - effectiveTendered.value);
	return diff > 0 ? diff : 0;
});

const hasRecordedPayment = computed(() => roundCurrency(effectiveTendered.value) > 0);

const defaultChangeMode = computed(() => {
	const modes = posStore.cashTenderModes;
	const configured = modes.find((mode) => mode.mode_of_payment === posStore.cashModeOfPayment);
	if (configured) return configured.mode_of_payment;
	const inInvoiceCurrency = modes.find((mode) => mode.pos_tender_currency === invoiceCurrency.value);
	return (inInvoiceCurrency || modes[0])?.mode_of_payment || posStore.cashModeOfPayment;
});

function buildChangeLegFor(mode: string, nativeAmount: number): InvoiceChangeLeg {
	return buildChangeLeg(mode, nativeAmount, tenderContext.value);
}

const changeAllocatedBase = computed(() => changeBaseTotal(changeLegs.value, invoiceCurrency.value));

const changeRemaining = computed(() =>
	remainingChange(changeAmount.value, changeLegs.value, invoiceCurrency.value),
);

const changeAllocationValid = computed(() =>
	isChangeAllocationValid(changeAmount.value, changeLegs.value, invoiceCurrency.value),
);

const showChangeAllocator = computed(
	() => changeAmount.value > 0 && posStore.allowMixedCurrencyTender && !cartStore.isReturnMode,
);

watch(
	changeAmount,
	(amount) => {
		if (amount <= 0 || cartStore.isReturnMode) {
			changeLegs.value = [];
			changeTouched.value = false;
			return;
		}
		if (!changeTouched.value) {
			changeLegs.value = [buildChangeLegFor(defaultChangeMode.value, amount)];
		}
	},
	{ immediate: true },
);

function addChangeLeg(mode: string) {
	const native = changeRemainingIn(posStore.tenderCurrencyFor(mode));
	changeTouched.value = true;
	changeLegs.value.push(buildChangeLegFor(mode, native));
}

function updateChangeLeg(index: number, nativeAmount: number) {
	const leg = changeLegs.value[index];
	if (!leg) return;
	changeTouched.value = true;
	changeLegs.value[index] = buildChangeLegFor(leg.mode_of_payment, nativeAmount);
}

function removeChangeLeg(index: number) {
	changeTouched.value = true;
	changeLegs.value.splice(index, 1);
}

function changeRemainingIn(currency: string): number {
	const mode = posStore.cashTenderModes.find((m) => m.pos_tender_currency === currency);
	return remainingIn(changeRemaining.value, currency, invoiceCurrency.value, mode?.exchange_rate || 0);
}

const canSubmitOutstanding = computed(() => {
	if (cartStore.isReturnMode || remainingAmount.value <= 0) return false;
	if (cartStore.isGiftCardSale) return false;
	if (posStore.allowCreditSale) return true;
	return hasRecordedPayment.value && posStore.allowPartialPayment;
});

const remainingLabel = computed(() => {
	return canSubmitOutstanding.value ? __("Outstanding After Save") : __("Remaining");
});

const outstandingSubmissionHint = computed(() => {
	if (!canSubmitOutstanding.value) return "";
	if (posStore.allowCreditSale) {
		return __("Invoice will be submitted with an outstanding credit balance.");
	}
	return __("Invoice will be submitted with a partial payment.");
});

const offlineBlockerMessages = computed(() => {
	if (offlineStore.isOnline) return [];
	return offlineSaleBlockers({
		invoice: {
			items: cartStore.items.map((item) => ({ gift_card_issue: item.gift_card_issue }) as never),
			payments: activeLegs.value.map((leg) => ({
				mode_of_payment: leg.mode_of_payment,
				amount: leg.base_amount,
				gift_card: leg.gift_card,
				gift_card_auth: leg.gift_card_auth,
			})) as never,
			is_credit_sale: remainingAmount.value > 0,
			customer_credit: creditApplied.value > 0 ? [{ source_type: "", source_name: "", amount: 0 }] : [],
			is_return: cartStore.isReturnMode,
		},
		offlinePaymentModes: posStore.offlinePaymentModes,
		outstanding: remainingAmount.value,
		catalog: offlineStore.catalogStatus,
		dbState: offlineStore.dbState,
		storage: offlineStore.storageHealth,
	}).map((blocker) => blocker.message);
});

const canSubmit = computed(() => {
	if (cartStore.isEmpty) return false;
	if (offlineBlockerMessages.value.length) return false;
	if (isGiftCardSale.value && !offlineStore.isOnline) return false;
	if (selectedRateMissing.value) return false;
	if (!isSplitPayment.value && referenceMissing.value) return false;
	const total = roundCurrency(Math.abs(cartStore.grandTotal));
	if (total <= 0) return true;
	if (remainingAmount.value > 0) {
		return canSubmitOutstanding.value;
	}
	if (!changeAllocationValid.value) return false;
	if (!isSplitPayment.value && !selectedMethod.value) return false;
	return roundCurrency(effectiveTendered.value + creditApplied.value) >= total;
});

onMounted(async () => {
	// before any awaits, so Enter / Ctrl+Enter / numpad echo work as soon as the dialog shows
	document.addEventListener("keydown", handleGlobalKeydown);

	if (!posStore.allowChangePostingDate || !cartStore.postingDate) {
		cartStore.postingDate = nowDate();
	}

	tenderedAmount.value = roundCurrency(Math.abs(cartStore.grandTotal));
	if (availableMethods.value.length > 0) {
		selectedMethod.value = availableMethods.value[0].mode_of_payment;
	}
	nextTick(() => {
		amountInput.value?.focus();
	});

	if (cartStore.customer) {
		try {
			const credit = await paymentStore.fetchAvailableCredit(
				cartStore.customer.name,
				posStore.companyName,
			);
			creditSources.value = credit?.sources || [];
			if (credit) {
				customerLoyaltyPoints.value = credit.loyalty_points || 0;
				customerLoyaltyAmount.value = credit.loyalty_amount || 0;
			}
		} catch {
			/* ignore */
		}

		try {
			if (customerStore.selectedCustomerInfo?.name !== cartStore.customer.name) {
				await customerStore.getCustomerInfo(cartStore.customer.name);
			}
			const info = customerStore.selectedCustomerInfo;
			if (info && info.name === cartStore.customer.name) {
				customerBalance.value = info.balance ?? null;
				customerCreditLimit.value = info.credit_limit ?? 0;
				if ((info.loyalty_points ?? 0) > 0) {
					const conversionFactor = info.loyalty_program?.conversion_factor || 1;
					customerLoyaltyPoints.value = info.loyalty_points!;
					customerConversionFactor.value = conversionFactor;
					customerLoyaltyAmount.value = info.loyalty_points! * conversionFactor;
				}
			}
		} catch {
			/* non-critical */
		}
	}
});

watch(
	() => cartStore.loyaltyAmount,
	() => {
		if (!isSplitPayment.value) {
			const newTotal = roundCurrency(Math.abs(cartStore.grandTotal));
			tenderedAmount.value = newTotal;
			nextTick(() => {
				amountInput.value?.setValue(newTotal);
			});
		}
	},
);

onUnmounted(() => {
	clearTimeout(pressedTimer);
	document.removeEventListener("keydown", handleGlobalKeydown);
});

function handleAmountInputSubmit(event: KeyboardEvent) {
	if (isSubmitting.value) return;

	if (referenceMissing.value && tenderedAmount.value > 0) {
		referenceRef.value?.focus();
		return;
	}

	if (isPaymentDialogSaveOnlyShortcut(event)) {
		if (canSubmit.value) {
			submitPayment(false);
		}
		return;
	}

	if (isSplitPayment.value) {
		addSplitPayment();
		return;
	}

	if (isPaymentDialogSaveAndPrintShortcut(event) && canSubmit.value) {
		submitPayment(true);
	}
}

/** The on-screen key echoing the physical one, so typed digits visibly land on the numpad. */
const pressedKey = ref("");
let pressedTimer: ReturnType<typeof setTimeout> | undefined;

function numpadKeyFor(e: KeyboardEvent): string {
	if (e.ctrlKey || e.metaKey || e.altKey) return "";
	if (/^[0-9]$/.test(e.key)) return e.key;
	if (e.key === "Backspace") return "⌫";
	if (e.key === "Delete") return "C";
	return "";
}

function flashNumpadKey(e: KeyboardEvent) {
	const key = numpadKeyFor(e);
	if (!key) return;
	pressedKey.value = key;
	clearTimeout(pressedTimer);
	pressedTimer = setTimeout(() => (pressedKey.value = ""), 160);
}

function handleGlobalKeydown(e: KeyboardEvent) {
	if (!cartStore.showPaymentDialog || isSubmitting.value) return;
	flashNumpadKey(e);

	if (isPaymentDialogSaveOnlyShortcut(e) && canSubmit.value) {
		e.preventDefault();
		e.stopPropagation();
		submitPayment(false);
		return;
	}

	if (isPaymentDialogSaveAndPrintShortcut(e) && canSubmit.value) {
		const target = e.target as HTMLElement;
		if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
		e.preventDefault();
		e.stopPropagation();
		submitPayment(true);
	}
}

function focusMethod(idx: number) {
	const methods = availableMethods.value;
	const clamped = Math.max(0, Math.min(idx, methods.length - 1));
	methodRefs[clamped]?.focus();
	selectMethod(methods[clamped].mode_of_payment);
}

function focusMethodByIndex() {
	const currentIdx = availableMethods.value.findIndex((m) => m.mode_of_payment === selectedMethod.value);
	focusMethod(currentIdx >= 0 ? currentIdx : 0);
}

function focusAmountInput() {
	amountInput.value?.focus();
}

function focusFirstQuickAmount() {
	(quickAmountRefs[0] as HTMLElement)?.focus();
}

function focusQuickAmount(idx: number) {
	const clamped = Math.max(0, Math.min(idx, quickAmounts.value.length - 1));
	(quickAmountRefs[clamped] as HTMLElement)?.focus();
}

function focusSubmitBtn() {
	const el = submitBtn.value?.$el as HTMLElement | undefined;
	(el as HTMLButtonElement)?.focus();
}

function selectMethod(method: string) {
	selectedMethod.value = method;
}

function setQuickAmount(amount: number) {
	const rounded = roundCurrency(amount);
	tenderedAmount.value = rounded;
	setTimeout(() => {
		amountInput.value?.setValue(rounded);
	});
	focusAmountInput();
}

function enableSplitPayment() {
	isSplitPayment.value = true;
	splitPayments.value = [];
	tenderedAmount.value = 0;
}

function refillTenderRemainder() {
	const owed = Math.max(0, roundCurrency(Math.abs(cartStore.grandTotal) - splitTotal.value));
	const rate = posStore.tenderRateFor(selectedMethod.value) || 1;
	tenderedAmount.value = roundFor(selectedCurrency.value, owed / rate);
}

function addSplitPayment() {
	if (!selectedMethod.value || tenderedAmount.value <= 0) return;
	if (referenceMissing.value) {
		referenceRef.value?.focus();
		return;
	}
	const leg = withReference(buildLeg(selectedMethod.value, tenderedAmount.value));
	mergeTenderLeg(splitPayments.value, leg, tenderContext.value);
	referenceNo.value = "";
	refillTenderRemainder();
}

function removeSplitPayment(idx: number) {
	splitPayments.value.splice(idx, 1);
	cartStore.setGiftCardTender(hasGiftCardLegs.value || cartStore.returnGiftCards.length > 0);
	refillTenderRemainder();
}

function openGiftInput() {
	showGiftInput.value = true;
	nextTick(() => giftCodeRef.value?.focus());
}

function addGiftCardLeg(mode: string, amount: number, card: Partial<TenderLeg>) {
	if (!isSplitPayment.value) {
		isSplitPayment.value = true;
		splitPayments.value = [];
	}
	splitPayments.value.push({ ...buildLeg(mode, amount), ...card });
	const other = availableMethods.value[0]?.mode_of_payment;
	if (other) selectedMethod.value = other;
	refillTenderRemainder();
}

async function applyGiftCard() {
	const code = giftCodeInput.value.trim();
	if (!code || checkingGift.value) return;
	if (!isOnline()) {
		showError(__("Gift cards need a live connection."));
		return;
	}
	checkingGift.value = true;
	try {
		const card = await checkGiftCard(code, posStore.profileName);
		if (splitPayments.value.some((leg) => leg.gift_card === card.gift_card)) {
			showInfo(__("This gift card is already applied."));
			return;
		}
		// a sale paid by card is charged to the cent, so drop rounding before working out what is due
		cartStore.setGiftCardTender(true);
		const paidSoFar = isSplitPayment.value ? splitTotal.value : 0;
		const due = roundCurrency(Math.abs(cartStore.grandTotal) - paidSoFar);
		const amount = roundCurrency(Math.min(card.balance, due));
		if (amount <= 0) {
			cartStore.setGiftCardTender(hasGiftCardLegs.value);
			showInfo(__("Nothing is left to pay."));
			return;
		}
		addGiftCardLeg(card.mode_of_payment, amount, {
			gift_card: card.gift_card,
			gift_card_auth: card.auth,
			masked_code: card.masked_code,
		});
		giftCodeInput.value = "";
		showGiftInput.value = false;
		showInfo(
			__("Gift card {0}: {1} applied, {2} left on the card.", [
				card.masked_code,
				money(amount),
				money(card.balance - amount),
			]),
		);
	} catch (error) {
		showError(extractErrorMessage(error));
	} finally {
		checkingGift.value = false;
	}
}

function refundToGiftCard(card: GiftCardRefund) {
	const paidSoFar = isSplitPayment.value ? splitTotal.value : 0;
	const due = roundCurrency(Math.abs(cartStore.grandTotal) - paidSoFar);
	const amount = roundCurrency(Math.min(card.amount, due));
	if (amount <= 0) return;
	addGiftCardLeg(posStore.giftCardMode, amount, {
		gift_card: card.gift_card,
		masked_code: card.masked_code,
	});
}

watch(selectedCurrency, (next, prev) => {
	if (!prev || next === prev) return;
	refillTenderRemainder();
});

function openLoyaltyInput() {
	if (maxRedeemablePoints.value <= 0) {
		showInfo(__("No redeemable loyalty points for this invoice total"));
		return;
	}
	redeemPointsInput.value = maxRedeemablePoints.value;
	showLoyaltyInput.value = true;
}

function applyLoyalty() {
	const maxPoints = maxRedeemablePoints.value;
	if (maxPoints <= 0) return;

	const points = Math.min(Math.max(Number(redeemPointsInput.value) || 0, 1), maxPoints);
	const amount = roundCurrency(points * (customerConversionFactor.value || 1));
	if (amount <= 0) return;

	cartStore.setLoyalty(points, amount);
	if (!isSplitPayment.value) {
		const newTotal = roundCurrency(Math.abs(cartStore.grandTotal));
		tenderedAmount.value = newTotal;
		nextTick(() => {
			amountInput.value?.setValue(newTotal);
		});
	}
	showLoyaltyInput.value = false;
}

function cancelLoyaltyInput() {
	showLoyaltyInput.value = false;
}

function getMethodIcon(method: string) {
	const lower = method.toLowerCase();
	if (lower.includes("cash")) return Banknote;
	if (lower.includes("card") || lower.includes("credit") || lower.includes("debit")) return CreditCard;
	if (lower.includes("bank") || lower.includes("transfer")) return Landmark;
	if (lower.includes("mobile") || lower.includes("wallet")) return Smartphone;
	if (lower.includes("check") || lower.includes("cheque")) return FileText;
	return DollarSign;
}

function handleNumpad(key: string) {
	const current = String(tenderedAmount.value || "");
	if (key === "C") {
		tenderedAmount.value = 0;
		return;
	}
	const next = key === "⌫" ? parseFloat(current.slice(0, -1)) : parseFloat(current + key);
	tenderedAmount.value = roundFor(selectedCurrency.value, next || 0);
}

function validateForSubmission(): { valid: boolean; message?: string } {
	if (cartStore.isEmpty) {
		return { valid: false, message: __("Cart is empty") };
	}

	if (!cartStore.customer?.name) {
		return { valid: false, message: __("Customer is required") };
	}

	if (cartStore.isReturnMode) {
		if (!cartStore.returnAgainst) {
			return { valid: false, message: __("Return against invoice is required for returns") };
		}

		const invalidItems = cartStore.items.filter((item) => item.qty >= 0);
		if (invalidItems.length > 0) {
			return { valid: false, message: __("Return items must have negative quantities") };
		}

		if (cartStore.grandTotal >= 0) {
			return { valid: false, message: __("Return total must be negative (refund amount)") };
		}
	} else {
		const invalidItems = cartStore.items.filter((item) => item.qty <= 0);
		if (invalidItems.length > 0) {
			return { valid: false, message: __("All items must have positive quantities") };
		}
	}

	if (isGiftCardSale.value && !isOnline()) {
		return {
			valid: false,
			message: __("Gift cards need a live connection. This sale cannot be saved offline."),
		};
	}

	if (selectedRateMissing.value) {
		return {
			valid: false,
			message: __("No exchange rate is available for {0}. Set today's rate before accepting it.", [
				selectedCurrency.value,
			]),
		};
	}

	if (creditApplied.value > roundCurrency(Math.abs(cartStore.grandTotal))) {
		return { valid: false, message: __("Customer credit is more than the amount due.") };
	}

	if (!cartStore.isReturnMode && remainingAmount.value > 0 && !canSubmitOutstanding.value) {
		return {
			valid: false,
			message: __("Tendered {0} covers {1}. {2} is still due.", [
				formatWithSymbol(invoiceCurrency.value, effectiveTendered.value),
				formatWithSymbol(invoiceCurrency.value, Math.abs(cartStore.grandTotal)),
				formatWithSymbol(invoiceCurrency.value, remainingAmount.value),
			]),
		};
	}

	if (!changeAllocationValid.value) {
		return {
			valid: false,
			message: __("Change of {0} is not fully allocated. {1} is unaccounted for.", [
				formatWithSymbol(invoiceCurrency.value, changeAmount.value),
				formatWithSymbol(invoiceCurrency.value, changeRemaining.value),
			]),
		};
	}

	return { valid: true };
}

function buildSubmissionPayments(): InvoicePayment[] {
	return toInvoicePayments(activeLegs.value, invoiceCurrency.value);
}

function buildInvoicePayload(): InvoiceData {
	const shiftName = posStore.posOpeningShift?.name || "";
	const payments = cartStore.isReturnMode
		? negateForReturn(buildSubmissionPayments())
		: buildSubmissionPayments();

	cartStore.setPayments(payments);
	cartStore.setChangeAmount(cartStore.isReturnMode ? 0 : changeAmount.value);
	cartStore.setChangeLegs(cartStore.isReturnMode ? [] : changeLegs.value.filter((leg) => leg.amount > 0));

	const invoiceData = cartStore.getInvoiceData(posStore.profileName, shiftName);

	if (!cartStore.isReturnMode && remainingAmount.value > 0 && posStore.allowCreditSale) {
		invoiceData.is_credit_sale = true;
	}

	if (creditApplied.value > 0) {
		invoiceData.customer_credit = creditSources.value
			.map((source) => ({
				source_type: source.source_type,
				source_name: source.source_name,
				amount: roundCurrency(
					Math.min(creditAllocations.value[creditKey(source)] || 0, source.available),
				),
			}))
			.filter((row) => row.amount > 0);
	}

	return invoiceData;
}

/** The cart this checkout belongs to. Every response is applied to it, never to the cart on screen. */
let origin: SaleOrigin | null = null;
/** The server may or may not have the sale: the cart stays locked until Pay finishes it. */
let outcomeUnknown = false;

async function submitPayment(withPrint: boolean = true) {
	if (isSubmitting.value) return;
	if (cartSessions.submitBlockedReason) {
		failSubmit(cartSessions.submitBlockedReason);
		return;
	}

	if (showLoyaltyInput.value && !cartStore.redeemLoyaltyPoints && (redeemPointsInput.value || 0) > 0) {
		applyLoyalty();
	}

	if (!canSubmit.value) return;

	const validation = validateForSubmission();
	if (!validation.valid) {
		failSubmit(validation.message || __("Validation failed"));
		return;
	}

	if (cartStore.checkoutBlockers.length) {
		failSubmit(cartStore.checkoutBlockers.join("\n"));
		return;
	}

	isSubmitting.value = true;
	const cartId = cartStore.cartId;
	cartSessions.beginSubmit(cartId);
	outcomeUnknown = false;
	setSubmitState("checking", __("Checking stock..."));
	const stockCheck = await cartStore.revalidateStock();
	if (!stockCheck.valid) {
		isSubmitting.value = false;
		cartSessions.endSubmit(cartId, "idle");
		failSubmit(stockCheck.messages.join("\n"));
		return;
	}

	printAfterSave.value = withPrint;
	setSubmitState("saving", __("Saving the sale. Keep this window open."));

	const invoiceData = buildInvoicePayload();
	origin = captureSaleOrigin(cartStore, invoiceData, authStore.userFullName);
	const giftCardSale = hasGiftCardActivity(invoiceData);
	try {
		const shiftName = posStore.posOpeningShift?.name || "";

		if (giftCardSale || invoiceData.customer_credit?.length) {
			await submitGiftCardSale(invoiceData, withPrint);
			return;
		}

		if (!isOnline()) {
			const saved = await completeOfflineSale(invoiceData, {
				withPrint,
				cashier: authStore.userFullName,
				origin: origin ?? undefined,
			});
			if (!saved) failSubmit(lastFailure.value || __("Failed to save invoice offline"));
			return;
		}
		const result = await submitDurableInvoice(invoiceData, origin.receipt, async () => {
			let response = await call<CreateInvoiceResult>("xpos.api.invoices.create_invoice", {
				data: JSON.stringify(invoiceData),
			});
			return await finalizeWithLocalFbr(response);
		});
		if (handleRepricing(result)) return;

		posStore.lastInvoiceName = result.name;

		if (cartStore.isReturnMode) {
			showSuccess(__("Return {0} saved successfully!", [result.name]));
		} else {
			showSuccess(__("Invoice {0} saved successfully!", [result.name]));
		}

		finishOrigin();
		if (withPrint && result.name) {
			try {
				await printInvoice(result.name);
			} catch {
				showError(__("Sale saved. Receipt printing failed; use Reprint."));
			}
		}
	} catch (error: unknown) {
		if (error instanceof FiscalUncertainError) {
			await holdForFiscalCheck(error, invoiceData, true);
		} else if (isTabConflictError(error)) {
			showError(__("This tab was changed on another terminal. Reload it and try again."));
			cartStore.closePaymentDialog();
			cartStore.openDraftDialog();
		} else if (isNetworkError(error)) {
			const saved = await completeOfflineSale(invoiceData, {
				withPrint,
				cashier: authStore.userFullName,
				origin: origin ?? undefined,
			});
			if (saved) return;
			outcomeUnknown = true;
			failSubmit(lastFailure.value || __("You are offline. Invoice could not be saved locally."));
		} else {
			failSubmit(__("Payment failed: {0}", [extractErrorMessage(error)]));
		}
		console.error("Payment error:", error);
	} finally {
		isSubmitting.value = false;
		printAfterSave.value = false;
		cartSessions.endSubmit(cartId, outcomeUnknown ? "uncertain" : "idle");
		origin = null;
		if (submitState.value === "checking" || submitState.value === "saving") setSubmitState("idle");
	}
}

/** The sale is done: finish the cart it came from, and only that one. */
function finishOrigin() {
	if (origin) cartSessions.finish({ cartId: origin.cartId, localId: origin.localId });
	else cartStore.clearAll();
}

/**
 * Gift card value moves only on a live server, so these sales skip the offline queue. If the
 * response is lost the cart stays put: paying again resends the same sale, which the server
 * recognises and never charges twice.
 */
async function submitGiftCardSale(invoiceData: InvoiceData, withPrint: boolean) {
	if (!isOnline()) {
		failSubmit(
			invoiceData.customer_credit?.length
				? __("Customer credit needs a live connection. This sale cannot be saved offline.")
				: __("Gift cards need a live connection. This sale cannot be saved offline."),
		);
		return;
	}
	let result: CreateInvoiceResult;
	try {
		result = await call<CreateInvoiceResult>("xpos.api.invoices.create_invoice", {
			data: JSON.stringify(invoiceData),
		});
		result = await finalizeWithLocalFbr(result);
	} catch (error) {
		if (error instanceof FiscalUncertainError) {
			await holdForFiscalCheck(error, invoiceData, false);
		} else if (isNetworkError(error)) {
			outcomeUnknown = true;
			failSubmit(
				__(
					"The connection dropped before the server answered. Press Pay again to finish this sale; it will not be charged twice.",
				),
				"retry",
			);
		} else {
			failSubmit(__("Payment failed: {0}", [extractErrorMessage(error)]));
		}
		return;
	}

	if (handleRepricing(result)) return;
	posStore.lastInvoiceName = result.name;
	showSuccess(__("Invoice {0} saved successfully!", [result.name]));
	if (result.issued_gift_cards?.length) cartStore.showIssuedGiftCards(result.issued_gift_cards);
	finishOrigin();
	if (withPrint && result.name) {
		try {
			await printInvoice(result.name);
		} catch {
			showError(__("Sale saved. Receipt printing failed; use Reprint."));
		}
	}
}

function handleRepricing(result: CreateInvoiceResult): boolean {
	if (result.status !== "reprice_required") return false;
	const response = result as unknown as RepriceResponse;
	if (!origin || origin.cartId === cartStore.cartId) {
		cartStore.applyServerRepricing(response);
	} else {
		// The cashier has moved on: flag the cart it belongs to rather than repricing this one.
		cartSessions.applyToCart(origin.cartId, (snapshot) => {
			snapshot.repriceReview = response;
		});
	}
	showError(response.message);
	cartStore.closePaymentDialog();
	return true;
}

interface CreateInvoiceResult {
	name: string;
	usin?: string;
	issued_gift_cards?: IssuedGiftCard[];
	status?: string;
	doctype?: string;
	fbr_payload?: Record<string, unknown>;
	fbr_local_service_url?: string;
	message?: string;
}

/** Finish a sale the server saved as a draft waiting for FBR; other answers pass through. */
async function finalizeWithLocalFbr(pending: CreateInvoiceResult): Promise<CreateInvoiceResult> {
	if (pending.status === "fbr_uncertain")
		throw new FiscalUncertainError(pending.name || pending.usin || "", pending.message || "");
	if (pending.status !== "fbr_local_required") return pending;
	try {
		return await completeLocalFiscalization<CreateInvoiceResult>(pending);
	} catch (err) {
		if (!(err instanceof LocalFiscalRejected)) throw err;
		await call("xpos.api.invoices.discard_draft_invoice", {
			name: pending.name,
			doctype: pending.doctype,
		}).catch(() => {
			/* best-effort cleanup */
		});
		throw new Error(
			__("FBR fiscalization failed - both the FBR cloud and the local service are unavailable.") +
				" " +
				extractErrorMessage(err),
		);
	}
}

async function holdForFiscalCheck(error: FiscalUncertainError, invoiceData: InvoiceData, queued: boolean) {
	if (!queued) {
		await addPendingInvoice({
			data: invoiceData,
			receipt: origin?.receipt ?? cartStore.getReceiptSnapshot("", authStore.userFullName),
			customer_name: invoiceData.customer,
			grand_total: origin?.grandTotal ?? cartStore.grandTotal,
		});
	}
	finishOrigin();
	cartStore.closePaymentDialog();
	showError(
		__("FBR did not confirm invoice {0}. Check it under Pending invoices before selling it again.", [
			error.invoice,
		]),
	);
	await offlineStore.syncPendingInvoices();
}

function close() {
	// a sale on its way to the server must not lose its window
	if (isSubmitting.value) return;
	cartStore.closePaymentDialog();
}

function roundCurrency(value: number): number {
	return roundFor(invoiceCurrency.value, value);
}

function formatPrice(price: number | string) {
	return formatFor(invoiceCurrency.value, parseFloat(String(price) || "0"));
}

/** The same amount with the currency symbol, on the side the Currency doctype asks for. */
function money(price: number | string) {
	return formatWithSymbol(invoiceCurrency.value, parseFloat(String(price) || "0"));
}
</script>
