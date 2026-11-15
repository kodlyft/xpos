<template>
	<Transition name="slide-up-full">
		<div v-if="open" class="fixed inset-0 z-60 bg-black flex flex-col" :aria-modal="true" role="dialog">
			<div class="shrink-0 flex items-center justify-between px-4 py-3 bg-black/80 backdrop-blur-sm">
				<div class="flex items-center gap-2.5 text-white">
					<ScanBarcode class="w-5 h-5 text-primary" />
					<span class="font-semibold text-base">{{ __("Camera Scanner") }}</span>
				</div>
				<button
					class="w-9 h-9 flex items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 active:scale-95 transition-all"
					@click="emit('close')"
				>
					<X class="w-5 h-5" />
				</button>
			</div>

			<div class="flex-1 relative overflow-hidden">
				<video
					ref="videoEl"
					class="absolute inset-0 w-full h-full object-cover"
					autoplay
					muted
					playsinline
				/>

				<div class="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
					<div
						class="absolute inset-0"
						style="
							background: radial-gradient(
								ellipse 55% 35% at 50% 50%,
								transparent 0%,
								rgba(0, 0, 0, 0.55) 100%
							);
						"
					/>

					<div
						class="relative w-64 h-40 sm:w-72 sm:h-44"
						:class="lastDetected ? 'scanner-success' : ''"
					>
						<span
							class="absolute top-0 inset-s-0 w-7 h-7 border-t-4 border-s-4 rounded-tl-sm transition-colors duration-300"
							:class="lastDetected ? 'border-emerald-400' : 'border-primary'"
						/>
						<span
							class="absolute top-0 inset-e-0 w-7 h-7 border-t-4 border-e-4 rounded-tr-sm transition-colors duration-300"
							:class="lastDetected ? 'border-emerald-400' : 'border-primary'"
						/>
						<span
							class="absolute bottom-0 inset-s-0 w-7 h-7 border-b-4 border-s-4 rounded-bl-sm transition-colors duration-300"
							:class="lastDetected ? 'border-emerald-400' : 'border-primary'"
						/>
						<span
							class="absolute bottom-0 inset-e-0 w-7 h-7 border-b-4 border-e-4 rounded-br-sm transition-colors duration-300"
							:class="lastDetected ? 'border-emerald-400' : 'border-primary'"
						/>

						<div
							v-if="!lastDetected && scanning"
							class="absolute inset-s-2 inset-e-2 h-0.5 bg-primary/80 scan-line"
						/>

						<div
							v-if="lastDetected"
							class="absolute inset-0 bg-emerald-400/20 rounded-sm flex items-center justify-center"
						>
							<CheckCircle2 class="w-10 h-10 text-emerald-400 drop-shadow-lg" />
						</div>
					</div>

					<p class="mt-6 text-sm font-medium text-white/80 drop-shadow">
						<template v-if="!scanning && !error">{{ __("Starting camera…") }}</template>
						<template v-else-if="error">{{ error }}</template>
						<template v-else-if="lastDetected">
							<span class="text-emerald-300 font-semibold">{{ lastDetected }}</span>
						</template>
						<template v-else>{{ __("Point at a barcode to scan") }}</template>
					</p>
				</div>
			</div>

			<div
				class="shrink-0 bg-black/80 backdrop-blur-sm px-4 py-4 safe-bottom flex items-center justify-center gap-4"
			>
				<button
					v-if="torchSupported"
					@click="toggleTorch"
					class="w-12 h-12 flex items-center justify-center rounded-full text-white transition-all active:scale-90"
					:class="torchOn ? 'bg-amber-500' : 'bg-white/10 hover:bg-white/20'"
				>
					<Flashlight class="w-6 h-6" />
				</button>

				<p class="text-xs text-white/50 text-center flex-1">
					{{ __("Supported: QR, EAN, UPC, Code 128, Code 39 and more") }}
				</p>

				<button
					v-if="hasMultipleCameras"
					@click="switchCamera"
					class="w-12 h-12 flex items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 active:scale-90 transition-all"
				>
					<FlipHorizontal2 class="w-6 h-6" />
				</button>
			</div>
		</div>
	</Transition>
</template>

<script setup lang="ts">
import { ref, watch, onUnmounted } from "vue";
import { BrowserMultiFormatReader } from "@zxing/browser";
import { ScanBarcode, X, CheckCircle2, FlipHorizontal2, Flashlight } from "lucide-vue-next";
import __ from "@/lib/translate";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{
	(e: "close"): void;
	(e: "scanned", barcode: string): void;
}>();

const videoEl = ref<HTMLVideoElement | null>(null);
const scanning = ref(false);
const error = ref<string | null>(null);
const lastDetected = ref<string | null>(null);
const torchSupported = ref(false);
const torchOn = ref(false);
const hasMultipleCameras = ref(/Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent));

type FacingMode = "environment" | "user";
let facingMode: FacingMode = "environment";

let reader: BrowserMultiFormatReader | null = null;
let scanControls: { stop: () => void } | null = null;
let cooldownTimer: ReturnType<typeof setTimeout> | null = null;
let activeStream: MediaStream | null = null;

async function startScanning() {
	if (!videoEl.value) return;

	error.value = null;
	scanning.value = false;
	lastDetected.value = null;

	const constraints: MediaStreamConstraints = {
		video: { facingMode: { ideal: facingMode }, width: { ideal: 1280 }, height: { ideal: 720 } },
		audio: false,
	};

	try {
		reader = new BrowserMultiFormatReader();
		scanning.value = true;

		scanControls = await reader.decodeFromConstraints(constraints, videoEl.value, (result) => {
			if (result) {
				const code = result.getText();
				if (code && code !== lastDetected.value) handleDetected(code);
			}
		});

		if (videoEl.value?.srcObject) {
			activeStream = videoEl.value.srcObject as MediaStream;
			setTimeout(checkTorchAndCameras, 600);
		}
	} catch (e: any) {
		scanning.value = false;
		if (e?.name === "NotAllowedError") {
			error.value = __("Camera permission denied. Please allow camera access.");
		} else if (e?.name === "NotFoundError" || e?.name === "OverconstrainedError") {
			try {
				reader = new BrowserMultiFormatReader();
				scanning.value = true;
				scanControls = await reader.decodeFromConstraints(
					{ video: true, audio: false },
					videoEl.value,
					(result) => {
						if (result) {
							const code = result.getText();
							if (code && code !== lastDetected.value) handleDetected(code);
						}
					},
				);
				if (videoEl.value?.srcObject) {
					activeStream = videoEl.value.srcObject as MediaStream;
					setTimeout(checkTorchAndCameras, 600);
				}
			} catch (e2: any) {
				scanning.value = false;
				error.value = __("No camera found on this device.");
			}
		} else {
			error.value = __("Could not start camera.");
		}
	}
}

function handleDetected(code: string) {
	lastDetected.value = code;
	emit("scanned", code);
	if (cooldownTimer) clearTimeout(cooldownTimer);
	cooldownTimer = setTimeout(() => {
		lastDetected.value = null;
		emit("close");
	}, 600);
}

async function checkTorchAndCameras() {
	if (!activeStream) return;
	try {
		const track = activeStream.getVideoTracks()[0];
		const caps = track?.getCapabilities?.() as any;
		if (caps?.torch) torchSupported.value = true;
	} catch {
		/* ignore */
	}
	try {
		const devices = await navigator.mediaDevices.enumerateDevices();
		const videoInputs = devices.filter((d) => d.kind === "videoinput");
		if (videoInputs.length > 1) hasMultipleCameras.value = true;
	} catch {
		/* ignore */
	}
}

async function toggleTorch() {
	if (!activeStream) return;
	try {
		const track = activeStream.getVideoTracks()[0];
		torchOn.value = !torchOn.value;
		await (track as any).applyConstraints({ advanced: [{ torch: torchOn.value }] });
	} catch {
		/* ignore */
	}
}

async function switchCamera() {
	facingMode = facingMode === "environment" ? "user" : "environment";
	stopScanning();
	await startScanning();
}

function stopScanning() {
	if (scanControls) {
		try {
			scanControls.stop();
		} catch {
			/* ignore */
		}
		scanControls = null;
	}
	if (activeStream) {
		activeStream.getTracks().forEach((t) => t.stop());
		activeStream = null;
	}
	if (videoEl.value?.srcObject) {
		const stream = videoEl.value.srcObject as MediaStream;
		stream.getTracks().forEach((t) => t.stop());
		videoEl.value.srcObject = null;
	}
	reader = null;
	scanning.value = false;
	torchOn.value = false;
	torchSupported.value = false;
}

watch(
	() => props.open,
	async (val) => {
		if (val) {
			facingMode = "environment";
			lastDetected.value = null;
			error.value = null;
			setTimeout(startScanning, 150);
		} else {
			stopScanning();
			if (cooldownTimer) clearTimeout(cooldownTimer);
		}
	},
	{ immediate: true },
);

onUnmounted(() => {
	stopScanning();
	if (cooldownTimer) clearTimeout(cooldownTimer);
});
</script>

<style scoped>
@keyframes scan {
	0%,
	100% {
		top: 8px;
		opacity: 1;
	}

	50% {
		top: calc(100% - 8px);
		opacity: 0.8;
	}
}

.scan-line {
	animation: scan 1.8s ease-in-out infinite;
}

@keyframes scanner-flash {
	0% {
		box-shadow: 0 0 0 0 rgba(52, 211, 153, 0.6);
	}

	100% {
		box-shadow: 0 0 0 20px rgba(52, 211, 153, 0);
	}
}

.scanner-success {
	animation: scanner-flash 0.4s ease-out;
}
</style>
