<template>
	<div class="relative flex items-center">
		<ScanBarcode class="absolute inset-s-3 w-4 h-4 text-muted-foreground pointer-events-none" />
		<Input
			ref="inputRef"
			v-model="barcodeValue"
			class="ps-9 pe-9 h-9 text-sm"
			:class="{
				'ring-2 ring-success/50 border-success/30': flashSuccess,
				'ring-2 ring-destructive/50 border-destructive/30': flashError,
			}"
			:placeholder="__('Scan barcode...')"
			autocomplete="off"
			data-testid="barcode-input"
			@keydown.enter.prevent="onScan"
			@paste="onPaste"
		/>
		<Loader2 v-if="isScanning" class="absolute inset-e-3 w-4 h-4 text-muted-foreground animate-spin" />
		<Button
			v-else-if="barcodeValue"
			variant="ghost"
			size="icon"
			class="absolute inset-e-1 h-7 w-7"
			@click="clearInput"
		>
			<X class="w-3.5 h-3.5 text-muted-foreground" />
		</Button>
	</div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import { ScanBarcode, X, Loader2 } from "lucide-vue-next";
import Input from "@/components/ui/input/Input.vue";
import { Button } from "@/components/ui/button";
import __ from "@/lib/translate";

const emit = defineEmits<{
	(e: "scanned", barcode: string): void;
}>();

const inputRef = ref<InstanceType<typeof Input> | null>(null);
const barcodeValue = ref("");
const isScanning = ref(false);
const flashSuccess = ref(false);
const flashError = ref(false);

let flashTimer: ReturnType<typeof setTimeout> | null = null;

function getInputEl(): HTMLInputElement | null {
	if (!inputRef.value) return null;
	const el = (inputRef.value as any)?.$el;
	return el instanceof HTMLInputElement ? el : el?.querySelector?.("input") || null;
}

function onScan() {
	const val = barcodeValue.value.trim();
	if (!val) return;
	emit("scanned", val);
}

function onPaste(e: ClipboardEvent) {
	setTimeout(() => {
		const val = barcodeValue.value.trim();
		if (val) {
			emit("scanned", val);
		}
	}, 50);
}

function clearInput() {
	barcodeValue.value = "";
	getInputEl()?.focus();
}

function showSuccess() {
	flashError.value = false;
	flashSuccess.value = true;
	barcodeValue.value = "";
	if (flashTimer) clearTimeout(flashTimer);
	flashTimer = setTimeout(() => {
		flashSuccess.value = false;
	}, 600);
	getInputEl()?.focus();
}

function showError() {
	flashSuccess.value = false;
	flashError.value = true;
	if (flashTimer) clearTimeout(flashTimer);
	flashTimer = setTimeout(() => {
		flashError.value = false;
	}, 600);
	getInputEl()?.select();
}

function setScanning(val: boolean) {
	isScanning.value = val;
}

function focus() {
	getInputEl()?.focus();
}

function clear() {
	barcodeValue.value = "";
}

function handleGlobalKey(e: KeyboardEvent) {
	if (e.key === "F2") {
		e.preventDefault();
		getInputEl()?.focus();
		getInputEl()?.select();
	}
}

onMounted(() => {
	document.addEventListener("keydown", handleGlobalKey);
});

onUnmounted(() => {
	document.removeEventListener("keydown", handleGlobalKey);
	if (flashTimer) clearTimeout(flashTimer);
});

defineExpose({ focus, clear, showSuccess, showError, setScanning });
</script>
