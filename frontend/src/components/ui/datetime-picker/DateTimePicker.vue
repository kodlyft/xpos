<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch, type HTMLAttributes } from "vue";
import AirDatepicker from "air-datepicker";
import localeModule from "air-datepicker/locale/en";
import { CalendarDays, Clock, X } from "lucide-vue-next";
import { inputVariants } from "@/components/ui/input";
import { __, cn } from "@/lib/utils";
import "air-datepicker/air-datepicker.css";
type DateTimeMode = "date" | "time" | "datetime";

const props = withDefaults(
	defineProps<{
		modelValue?: string;
		mode?: DateTimeMode;
		placeholder?: string;
		disabled?: boolean;
		minDate?: string;
		maxDate?: string;
		use12Hour?: boolean;
		firstDayOfWeek?: 0 | 1;
		showToday?: boolean;
		showNow?: boolean;
		clearable?: boolean;
		label?: string;
		ariaLabel?: string;
		class?: HTMLAttributes["class"];
		compact?: boolean;
	}>(),
	{
		mode: "datetime",
		placeholder: "Pick date & time",
		disabled: false,
		use12Hour: false,
		firstDayOfWeek: 1,
		showToday: true,
		showNow: true,
		clearable: true,
	},
);

const emit = defineEmits<{
	(e: "update:modelValue", value: string): void;
	(e: "change", value: string): void;
}>();

const input = ref<HTMLInputElement | null>(null);
const hasValue = ref(false);
const invalid = ref(false);
let picker: AirDatepicker<HTMLInputElement> | null = null;
let syncing = false;

// The locale ships as CommonJS, so the bundler may hand back the module wrapper instead of the locale.
const localeEn = ((localeModule as unknown as { default?: typeof localeModule }).default ??
	localeModule) as typeof localeModule;

const pad = (value: number) => String(value).padStart(2, "0");

function parseUserDate(text: string): string | null {
	const trimmed = text.trim();
	let day: number, month: number, year: number;
	const iso = trimmed.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
	if (iso) {
		[year, month, day] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
	} else {
		const user = trimmed.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
		if (!user) return null;
		[day, month, year] = [Number(user[1]), Number(user[2]), Number(user[3])];
		if (year < 100) year += year < 50 ? 2000 : 1900;
	}
	const test = new Date(year, month - 1, day);
	if (test.getFullYear() !== year || test.getMonth() !== month - 1 || test.getDate() !== day) return null;
	return `${year}-${pad(month)}-${pad(day)}`;
}

function parseUserTime(text: string): string | null {
	const match = text.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]m)?$/i);
	if (!match) return null;
	let hours = Number(match[1]);
	const minutes = Number(match[2]);
	const seconds = Number(match[3] ?? 0);
	const meridiem = match[4]?.toLowerCase();
	if (meridiem) {
		if (hours < 1 || hours > 12) return null;
		hours %= 12;
		if (meridiem === "pm") hours += 12;
	}
	if (hours > 23 || minutes > 59 || seconds > 59) return null;
	return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

/** Split a model value into its date ("YYYY-MM-DD") and time ("HH:mm:ss") parts. */
function split(value: string | undefined): { date: string; time: string } {
	const text = (value ?? "").trim();
	if (!text) return { date: "", time: "" };
	if (props.mode === "time") return { date: "", time: parseUserTime(text) ?? "" };
	const [date = "", time = ""] = text.split(/[ T]/);
	return { date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "", time: parseUserTime(time) ?? "" };
}

function toDate(value: string | undefined): Date | null {
	const { date, time } = split(value);
	if (props.mode === "time") {
		if (!time) return null;
		const [h, m, s] = time.split(":").map(Number);
		const now = new Date();
		return new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, s);
	}
	if (!date) return null;
	const [y, mo, d] = date.split("-").map(Number);
	const [h = 0, m = 0, s = 0] = (time || "00:00:00").split(":").map(Number);
	return new Date(y, mo - 1, d, h, m, s);
}

function toModel(date: Date, previous: string): string {
	const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
	const seconds = split(previous).time.split(":")[2] ?? "00";
	const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${seconds}`;
	if (props.mode === "date") return day;
	if (props.mode === "time") return time;
	return `${day} ${time}`;
}

const timeFormat = computed(() => (props.use12Hour ? "hh:mm AA" : "HH:mm"));
const dateFormat = "dd/MM/yyyy";
const displayFormat = computed(() => {
	if (props.mode === "date") return dateFormat;
	if (props.mode === "time") return timeFormat.value;
	return `${dateFormat} ${timeFormat.value}`;
});

function show(value: string | undefined) {
	if (!input.value) return;
	const date = toDate(value);
	input.value.value = date && picker ? picker.formatDate(date, displayFormat.value) : "";
	hasValue.value = Boolean(date);
}

function commit(value: string) {
	emit("update:modelValue", value);
	emit("change", value);
}

function sync(value: string | undefined) {
	if (!picker) return;
	const date = toDate(value);
	syncing = true;
	if (date) {
		void picker.selectDate(date, { updateTime: props.mode !== "date", silent: true });
		picker.setViewDate(date);
	} else {
		picker.clear({ silent: true });
	}
	syncing = false;
	show(value);
}

/** Inside a modal the picker must live in the dialog, or the modal's focus trap and pointer lock swallow it. */
function pickerContainer(): HTMLElement {
	return (input.value?.closest("[role='dialog']") as HTMLElement | null) ?? document.body;
}

function build() {
	const element = input.value;
	if (!element || picker) return;
	const container = pickerContainer();
	const withTime = props.mode !== "date";

	picker = new AirDatepicker<HTMLInputElement>(element, {
		locale: {
			...localeEn,
			dateFormat,
			timeFormat: timeFormat.value,
			firstDay: props.firstDayOfWeek,
			today: __("Today"),
			clear: __("Clear"),
		},
		dateFormat,
		timeFormat: timeFormat.value,
		timepicker: withTime,
		onlyTimepicker: props.mode === "time",
		autoClose: props.mode === "date",
		minDate: props.minDate ? toDate(props.minDate) || undefined : undefined,
		maxDate: props.maxDate ? toDate(props.maxDate) || undefined : undefined,
		isMobile: false,
		container,
		buttons: [
			...(props.mode !== "time" && props.showToday
				? [
						{
							content: __("Today"),
							onClick(dp: AirDatepicker) {
								const now = new Date();
								void dp.selectDate(now, { updateTime: false });
								dp.setViewDate(now);
							},
						},
					]
				: []),
			...(withTime && props.showNow
				? [
						{
							content: __("Now"),
							onClick(dp: AirDatepicker) {
								const now = new Date();
								void dp.selectDate(now, { updateTime: true });
								dp.setViewDate(now);
							},
						},
					]
				: []),
			...(props.clearable ? ["clear" as const] : []),
		],
		position({ $datepicker, $target, $pointer }) {
			const box = $target.getBoundingClientRect();
			const host = container === document.body ? null : container.getBoundingClientRect();
			const width = $datepicker.offsetWidth;
			const height = $datepicker.offsetHeight;
			const below = box.bottom + height + 8 <= window.innerHeight || box.top < height + 8;
			const top = below ? box.bottom + 6 : box.top - height - 6;
			const rtl = document.documentElement.dir === "rtl";
			let left = rtl ? box.right - width : box.left;
			left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
			$datepicker.style.position = "absolute";
			$datepicker.style.top = `${top - (host ? host.top : -window.scrollY)}px`;
			$datepicker.style.left = `${left - (host ? host.left : -window.scrollX)}px`;
			$pointer.style.display = "none";
		},
		selectedDates: toDate(props.modelValue) ? [toDate(props.modelValue)!] : [],
		onSelect({ date }) {
			if (syncing) return;
			const picked = Array.isArray(date) ? date[0] : date;
			invalid.value = false;
			commit(picked ? toModel(picked, props.modelValue ?? "") : "");
		},
	});
	show(props.modelValue);
}

onMounted(build);
onBeforeUnmount(() => {
	picker?.destroy();
	picker = null;
});

watch(
	() => props.modelValue,
	(value) => sync(value),
);
watch(
	() => [props.minDate, props.maxDate, props.use12Hour, props.firstDayOfWeek],
	() => {
		picker?.update({
			minDate: props.minDate ? toDate(props.minDate) || undefined : undefined,
			maxDate: props.maxDate ? toDate(props.maxDate) || undefined : undefined,
			timeFormat: timeFormat.value,
			locale: { ...localeEn, dateFormat, timeFormat: timeFormat.value, firstDay: props.firstDayOfWeek },
		});
		show(props.modelValue);
	},
);

/** Typed entry: dd/mm/yyyy (or yyyy-mm-dd) with an optional time; anything unreadable snaps back. */
function commitTyped() {
	const text = input.value?.value.trim() ?? "";
	if (!text) {
		invalid.value = false;
		if (props.modelValue) commit("");
		return;
	}
	let next: string | null = null;
	if (props.mode === "time") {
		next = parseUserTime(text);
	} else {
		const [datePart = "", ...rest] = text.split(/\s+/);
		const date = parseUserDate(datePart);
		const time = rest.length ? parseUserTime(rest.join(" ")) : split(props.modelValue).time || "00:00:00";
		if (date && time) next = props.mode === "date" ? date : `${date} ${time}`;
	}
	if (!next) {
		invalid.value = true;
		show(props.modelValue);
		return;
	}
	invalid.value = false;
	if (next !== props.modelValue) commit(next);
	else show(props.modelValue);
}

function clearValue() {
	invalid.value = false;
	commit("");
}

function openPicker() {
	if (props.disabled) return;
	build();
	picker?.show();
}
</script>

<template>
	<div :class="cn('relative', props.class)">
		<label v-if="label" class="mb-1.5 block text-sm font-medium text-foreground">{{ label }}</label>
		<div class="relative">
			<component
				:is="mode === 'time' ? Clock : CalendarDays"
				class="pointer-events-none absolute inset-s-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
				aria-hidden="true"
			/>
			<input
				ref="input"
				type="text"
				autocomplete="off"
				inputmode="numeric"
				:disabled="disabled"
				:placeholder="placeholder"
				:aria-label="ariaLabel || label || placeholder"
				:aria-invalid="invalid || undefined"
				:class="
					cn(
						inputVariants({ size: compact ? 'compact' : 'default' }),
						'w-full ps-9',
						clearable && hasValue ? 'pe-9' : '',
						invalid && 'border-destructive',
					)
				"
				@focus="openPicker"
				@click="openPicker"
				@change="commitTyped"
				@keydown.enter="commitTyped"
			/>
			<button
				v-if="clearable && hasValue && !disabled"
				type="button"
				class="absolute inset-e-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
				:aria-label="__('Clear')"
				@click.stop="clearValue"
			>
				<X class="size-3.5" />
			</button>
		</div>
	</div>
</template>
