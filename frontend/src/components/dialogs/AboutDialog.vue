<template>
	<Dialog
		:open="open"
		@update:open="
			(val: boolean) => {
				if (!val) $emit('close');
			}
		"
	>
		<DialogContent class="max-w-md">
			<DialogHeader>
				<DialogTitle class="flex items-center gap-3">
					<XposLogo :size="40" />
					<span>{{ __("X POS") }}</span>
				</DialogTitle>
			</DialogHeader>

			<div class="space-y-4">
				<div class="text-center py-4">
					<p class="text-lg font-semibold text-foreground">
						{{ __("X POS") }}
					</p>
					<p class="text-sm text-muted-foreground">
						{{ __("Point of Sale Application for ERPNext") }}
					</p>
				</div>

				<div v-if="isLoadingInfo" class="flex justify-center py-4">
					<Loader2 class="w-5 h-5 animate-spin text-muted-foreground" />
				</div>

				<div v-else class="space-y-4 text-sm overflow-y-auto max-h-50">
					<div class="flex justify-between py-2 me-2 border-b border-border">
						<span class="text-muted-foreground">{{ __("Version") }}</span>
						<span class="font-medium">{{ version }}</span>
					</div>
					<div v-if="gitBranch" class="flex justify-between me-2 py-2 border-b border-border">
						<span class="text-muted-foreground">{{ __("Branch") }}</span>
						<span class="font-medium font-mono text-xs">{{ gitBranch }}</span>
					</div>
					<div v-if="gitHash" class="flex justify-between me-2 py-2 border-b border-border">
						<span class="text-muted-foreground">{{ __("Commit") }}</span>
						<span class="font-medium font-mono text-xs">{{ gitHash }}</span>
					</div>
					<div v-if="frappeVersion" class="flex justify-between me-2 py-2 border-b border-border">
						<span class="text-muted-foreground">{{ __("Frappe") }}</span>
						<span class="font-medium">{{ frappeVersion }}</span>
					</div>
					<div v-if="erpnextVersion" class="flex justify-between me-2 py-2 border-b border-border">
						<span class="text-muted-foreground">{{ __("ERPNext") }}</span>
						<span class="font-medium">{{ erpnextVersion }}</span>
					</div>
					<div class="flex justify-between me-2 py-2 border-b border-border">
						<span class="text-muted-foreground">{{ __("Mode") }}</span>
						<span class="font-medium">{{ __("Web Browser") }}</span>
					</div>
					<div class="flex justify-between me-2 py-2 border-b border-border">
						<span class="text-muted-foreground">{{ __("Company") }}</span>
						<span class="font-medium">{{ companyName || __("Not Set") }}</span>
					</div>
				</div>

				<div class="pt-3 border-t border-border">
					<div class="flex items-center justify-between gap-3">
						<div class="min-w-0">
							<p class="text-sm font-semibold text-foreground truncate">{{ COMPANY.name }}</p>
							<p class="text-xs text-muted-foreground">{{ __("Publisher") }}</p>
						</div>
						<div class="flex items-center gap-1 shrink-0">
							<a
								v-if="COMPANY.website"
								:href="COMPANY.website"
								target="_blank"
								rel="noopener noreferrer"
								:title="__('Website')"
								class="p-2 rounded-md text-muted-foreground transition-colors hover:text-foreground hover:bg-accent"
							>
								<Globe class="w-4 h-4" />
							</a>
							<a
								:href="COMPANY.github"
								target="_blank"
								rel="noopener noreferrer"
								:title="__('GitHub')"
								class="p-2 rounded-md text-muted-foreground transition-colors hover:text-foreground hover:bg-accent"
							>
								<Github class="w-4 h-4" />
							</a>
							<a
								:href="`mailto:${COMPANY.email}`"
								:title="__('Contact')"
								class="p-2 rounded-md text-muted-foreground transition-colors hover:text-foreground hover:bg-accent"
							>
								<Mail class="w-4 h-4" />
							</a>
						</div>
					</div>
				</div>

				<div class="pt-2 text-center text-xs text-muted-foreground">
					<p>
						&copy; {{ currentYear }} {{ COMPANY.name }} {{ __("and contributors") }} &middot;
						{{ __("MIT License") }}
					</p>
					<p class="mt-1">{{ __("Built with ❤️, using VueJS") }}</p>
				</div>
			</div>

			<DialogFooter>
				<Button variant="outline" @click="$emit('close')">
					{{ __("Close") }}
				</Button>
			</DialogFooter>
		</DialogContent>
	</Dialog>
</template>

<script setup lang="ts">
import { ref, inject, watch, type Ref } from "vue";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { usePosStore } from "@/stores/posStore";
import { call } from "@/services/api";
import { __ } from "@/lib/translate";
import { Github, Globe, Loader2, Mail } from "lucide-vue-next";

import { XposLogo } from "@/components/ui/brand";

const COMPANY = {
	name: "Kodlyft",
	github: "https://github.com/kodlyft",
	email: "hello@kodlyft.com",
	website: "https://kodlyft.com",
} as const;

const props = defineProps<{
	open: boolean;
}>();

defineEmits<{
	close: [];
}>();

const isDark = inject<Ref<boolean>>("isDark")!;
const posStore = usePosStore();

const version = ref("0.0.1");
const gitBranch = ref("");
const gitHash = ref("");
const frappeVersion = ref("");
const erpnextVersion = ref("");
const isLoadingInfo = ref(false);
const currentYear = new Date().getFullYear();

const companyName = posStore.companyName;

async function fetchVersionInfo() {
	isLoadingInfo.value = true;
	try {
		const info = await call<{
			xpos_version: string;
			frappe_version: string;
			erpnext_version: string;
			git_branch: string;
			git_hash: string;
			git_date: string;
		}>("xpos.api.utilities.get_version_info");

		if (info) {
			version.value = info.xpos_version || version.value;
			gitBranch.value = info.git_branch || "";
			gitHash.value = info.git_hash || "";
			frappeVersion.value = info.frappe_version || "";
			erpnextVersion.value = info.erpnext_version || "";
		}
	} catch (e) {
		console.warn("Could not fetch version info:", e);
	}

	isLoadingInfo.value = false;
}

watch(
	() => props.open,
	(isOpen) => {
		if (isOpen) {
			fetchVersionInfo();
		}
	},
);
</script>
