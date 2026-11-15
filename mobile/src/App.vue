<script setup lang="ts">
import { computed, onMounted } from "vue";
import { Receipt, ShoppingBag, Stethoscope, UserRound } from "@lucide/vue";
import { XposLogo } from "@/components/ui/brand";
import AppBar from "@mobile/ui/AppBar.vue";
import MobileShell from "@mobile/ui/MobileShell.vue";
import ServerSetup from "@mobile/screens/ServerSetup.vue";
import Login from "@mobile/screens/Login.vue";
import EnrollPin from "@mobile/screens/EnrollPin.vue";
import Unlock from "@mobile/screens/Unlock.vue";
import ProfilePick from "@mobile/screens/ProfilePick.vue";
import Sales from "@mobile/screens/Sales.vue";
import PaymentSheet from "@mobile/ui/PaymentSheet.vue";
import ReSignIn from "@mobile/ui/ReSignIn.vue";
import Sell from "@mobile/screens/Sell.vue";
import Diagnostics from "@mobile/screens/Diagnostics.vue";
import Account from "@mobile/screens/Account.vue";
import Toaster from "@mobile/ui/Toaster.vue";
import { toastOn } from "@mobile/composables/useToast";
import { boot, selectTab, useApp, type Tab } from "@mobile/composables/useApp";

const { state } = useApp();
toastOn(() => state.catalog.message, "warning");
onMounted(async () => {
	document.documentElement.classList.toggle("dark", matchMedia("(prefers-color-scheme: dark)").matches);
	await boot();
});

const tabs: { id: Tab; label: string; title: string; icon: unknown }[] = [
	{ id: "sell", label: "Sell", title: "Sell", icon: ShoppingBag },
	{ id: "sales", label: "Sales", title: "Sales", icon: Receipt },
	{ id: "account", label: "Account", title: "Account", icon: UserRound },
	{ id: "diagnostics", label: "Device", title: "Device & storage", icon: Stethoscope },
];
const screen = computed(
	() =>
		({
			setup: ServerSetup,
			login: Login,
			profile: ProfilePick,
			enroll: EnrollPin,
			locked: Unlock,
			booting: null,
			unsupported: null,
			unlocked: { sell: Sell, sales: Sales, account: Account, diagnostics: Diagnostics }[state.tab],
		})[state.phase],
);
</script>

<template>
	<MobileShell>
		<template v-if="state.phase === 'unlocked'" #header
			><AppBar :title="tabs.find((t) => t.id === state.tab)?.title ?? ''"
		/></template>
		<div
			v-if="state.phase === 'unsupported'"
			class="flex h-full flex-col items-center justify-center gap-3 p-6 text-center"
		>
			<XposLogo variant="full" :size="48" subtitle="Mobile" />
			<p class="text-base font-semibold">XPOS Mobile runs inside the Android app.</p>
			<p class="max-w-sm text-sm text-muted-foreground">
				Install the app on an Android phone or POS terminal, or run `yarn dev` in the mobile folder
				for browser development. For the browser POS, use the XPOS web POS.
			</p>
		</div>
		<div
			v-else-if="state.phase === 'booting'"
			class="flex h-full flex-col items-center justify-center gap-3 p-6"
			role="status"
			aria-label="Starting"
		>
			<XposLogo variant="full" :size="56" subtitle="Mobile" />
		</div>
		<component :is="screen" v-else />
		<PaymentSheet v-if="state.phase === 'unlocked'" />
		<ReSignIn />
		<template v-if="state.phase === 'unlocked'" #nav>
			<ul
				class="flex gap-1 rounded-xl border border-border bg-card/70 p-1 shadow-raised backdrop-blur-sm"
			>
				<li v-for="t in tabs" :key="t.id" class="flex-1">
					<button
						type="button"
						class="inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg border text-sm font-semibold transition-[background-color,border-color,box-shadow] duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
						:class="
							state.tab === t.id
								? 'border-primary bg-primary text-primary-foreground shadow-primary'
								: 'border-transparent text-foreground hover:bg-surface-hover'
						"
						:aria-current="state.tab === t.id ? 'page' : undefined"
						@click="selectTab(t.id)"
					>
						<component :is="t.icon" class="size-4.5" aria-hidden="true" />{{ t.label }}
					</button>
				</li>
			</ul>
		</template>
	</MobileShell>
	<Toaster />
</template>
