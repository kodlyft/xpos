<script setup lang="ts">
import { Lock, WifiOff, Wifi } from "@lucide/vue";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { XposLogo } from "@/components/ui/brand";
import { getLifecycle, lock, useApp } from "@mobile/composables/useApp";

// Floating header bar, same construction as the web POS Navbar.
defineProps<{ title: string }>();
const { state } = useApp();
const online = ref(getLifecycle().isOnline());
let off = () => {};
onMounted(() => (off = getLifecycle().onConnectivity((o) => (online.value = o))));
onBeforeUnmount(() => off());
const initials = computed(() => (state.cashier?.user ?? "?").slice(0, 2).toUpperCase());
</script>

<template>
	<div class="pad-safe-x pt-2">
		<header
			class="flex h-14 shrink-0 items-center gap-2 rounded-xl border border-border bg-card/70 px-2 shadow-raised backdrop-blur-sm"
		>
			<XposLogo :size="32" class="ms-1" />
			<p class="min-w-0 flex-1 truncate ps-1 text-base font-bold">{{ title }}</p>
			<span
				class="inline-flex h-8 items-center gap-1.5 rounded-lg border px-2 text-xs font-semibold"
				:class="
					online
						? 'border-success/30 bg-success-soft text-success-soft-foreground'
						: 'border-warning/30 bg-warning-soft text-warning-soft-foreground'
				"
				role="status"
			>
				<component :is="online ? Wifi : WifiOff" class="size-3.5" aria-hidden="true" />{{
					online ? "Online" : "Offline"
				}}
			</span>
			<Button
				variant="outline"
				size="icon"
				class="size-11 rounded-lg"
				aria-label="Lock the app"
				@click="lock('Locked by the cashier')"
				><Lock class="size-4.5!"
			/></Button>
			<Avatar size="sm" class="me-1" :title="state.cashier?.user"
				><AvatarFallback>{{ initials }}</AvatarFallback></Avatar
			>
		</header>
	</div>
</template>
