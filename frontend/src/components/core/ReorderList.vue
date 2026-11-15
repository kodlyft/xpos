<template>
	<ul ref="listRef" class="space-y-1" role="list" :aria-label="label">
		<template v-for="(entry, index) in items" :key="entry.id">
			<li
				v-if="dividerAt === index && index > 0"
				class="flex items-center gap-2 py-0.5 text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground"
				role="presentation"
				data-testid="reorder-divider"
			>
				<span class="h-px flex-1 bg-border" />
				{{ dividerLabel }}
				<span class="h-px flex-1 bg-border" />
			</li>
			<li
				:data-id="entry.id"
				class="flex items-center gap-1 rounded-lg border bg-card px-1.5 py-1 text-sm"
				:class="overId === entry.id ? 'border-primary' : 'border-border'"
				draggable="true"
				tabindex="0"
				:aria-label="rowLabel(entry, index)"
				data-testid="reorder-row"
				@keydown="onKeydown($event, index)"
				@dragstart="onDragStart($event, entry.id)"
				@dragover.prevent="overId = entry.id"
				@dragleave="overId === entry.id && (overId = null)"
				@drop.prevent="onDrop(entry.id)"
				@dragend="dragId = overId = null"
			>
				<GripVertical class="size-4 shrink-0 cursor-grab text-muted-foreground" aria-hidden="true" />
				<span class="min-w-0 flex-1 truncate" :title="entry.label">{{ entry.label }}</span>
				<Button
					variant="ghost"
					size="icon-sm"
					:disabled="index === 0"
					:aria-label="__('Move {0} up', [entry.label])"
					tabindex="-1"
					data-testid="move-up"
					@click="move(index, index - 1)"
				>
					<ArrowUp class="size-4!" />
				</Button>
				<Button
					variant="ghost"
					size="icon-sm"
					:disabled="index === items.length - 1"
					:aria-label="__('Move {0} down', [entry.label])"
					tabindex="-1"
					data-testid="move-down"
					@click="move(index, index + 1)"
				>
					<ArrowDown class="size-4!" />
				</Button>
				<Button
					v-if="dividerAt !== undefined && items.length > dividerAt"
					variant="ghost"
					size="icon-sm"
					:aria-label="
						index < dividerAt
							? __('Move {0} to the More menu', [entry.label])
							: __('Show {0} on the cart', [entry.label])
					"
					:title="index < dividerAt ? __('Move to the More menu') : __('Show on the cart')"
					tabindex="-1"
					data-testid="move-across"
					@click="move(index, index < dividerAt ? items.length - 1 : dividerAt - 1)"
				>
					<ArrowDownToLine v-if="index < dividerAt" class="size-4!" />
					<ArrowUpToLine v-else class="size-4!" />
				</Button>
				<Button
					v-if="removable"
					variant="ghost"
					size="icon-sm"
					:aria-label="__('Remove {0}', [entry.label])"
					tabindex="-1"
					data-testid="reorder-remove"
					@click="remove(entry.id)"
				>
					<X class="size-4!" />
				</Button>
			</li>
		</template>
	</ul>
</template>

<script setup lang="ts">
import { nextTick, ref } from "vue";
import { ArrowDown, ArrowDownToLine, ArrowUp, ArrowUpToLine, GripVertical, X } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { moveItem } from "@/services/posLayout";
import __ from "@/lib/translate";

interface Entry {
	id: string;
	label: string;
}

const props = defineProps<{
	items: Entry[];
	label: string;
	removable?: boolean;
	/** Index of the first row after a divider, e.g. where the More menu begins. */
	dividerAt?: number;
	dividerLabel?: string;
}>();

const emit = defineEmits<{ (e: "reorder", ids: string[]): void; (e: "remove", id: string): void }>();

const listRef = ref<HTMLElement | null>(null);
const dragId = ref<string | null>(null);
const overId = ref<string | null>(null);

const ids = () => props.items.map((entry) => entry.id);

function rowLabel(entry: Entry, index: number): string {
	return __("{0}, position {1} of {2}. Alt plus arrow keys to move.", [
		entry.label,
		index + 1,
		props.items.length,
	]);
}

async function move(from: number, to: number) {
	const next = moveItem(ids(), from, to);
	const id = ids()[from];
	emit("reorder", next);
	await nextTick();
	listRef.value?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)?.focus();
}

function remove(id: string) {
	emit("remove", id);
}

function onKeydown(event: KeyboardEvent, index: number) {
	if (event.target !== event.currentTarget) return;
	if (event.altKey && event.key === "ArrowUp") {
		event.preventDefault();
		void move(index, index - 1);
	} else if (event.altKey && event.key === "ArrowDown") {
		event.preventDefault();
		void move(index, index + 1);
	} else if (!event.altKey && event.key === "ArrowUp") {
		event.preventDefault();
		focusSibling(event.currentTarget as HTMLElement, -1);
	} else if (!event.altKey && event.key === "ArrowDown") {
		event.preventDefault();
		focusSibling(event.currentTarget as HTMLElement, 1);
	} else if (props.removable && (event.key === "Delete" || event.key === "Backspace")) {
		event.preventDefault();
		remove(props.items[index].id);
	}
}

function focusSibling(row: HTMLElement, step: number) {
	const rows = Array.from(listRef.value?.querySelectorAll<HTMLElement>("li[data-id]") ?? []);
	rows[rows.indexOf(row) + step]?.focus();
}

function onDragStart(event: DragEvent, id: string) {
	dragId.value = id;
	event.dataTransfer?.setData("text/plain", id);
	if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
}

function onDrop(targetId: string) {
	const from = ids().indexOf(dragId.value ?? "");
	const to = ids().indexOf(targetId);
	dragId.value = overId.value = null;
	if (from < 0 || to < 0 || from === to) return;
	emit("reorder", moveItem(ids(), from, to));
}
</script>
