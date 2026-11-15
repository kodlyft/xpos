<template>
	<div class="space-y-3">
		<p class="text-sm font-semibold">{{ __("Coupon") }}</p>
		<div class="flex items-center gap-2">
			<Input
				v-model="code"
				type="text"
				:placeholder="__('Enter coupon code...')"
				class="flex-1"
				@keydown.enter="$emit('apply')"
			/>
			<Button :loading="loading" :disabled="!code" @click="$emit('apply')">
				{{ __("Apply") }}
			</Button>
		</div>
		<p v-if="error" class="text-sm text-destructive-soft-foreground">{{ error }}</p>
	</div>
</template>

<script setup lang="ts">
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import __ from "@/lib/translate";

defineProps<{ loading: boolean; error: string }>();
defineEmits<{ (e: "apply"): void }>();

const code = defineModel<string>({ required: true });
</script>
