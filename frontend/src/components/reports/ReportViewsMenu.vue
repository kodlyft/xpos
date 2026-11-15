<script setup lang="ts">
import { ref } from "vue";
import { Bookmark, Star, Trash2 } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContentStyled, PopoverTrigger } from "@/components/ui/popover";
import __ from "@/lib/translate";
import type { ReportView } from "@/services/reportViews";

defineProps<{ views: ReportView[] }>();

const emit = defineEmits<{
	(e: "apply", view: ReportView): void;
	(e: "save", name: string, withFilters: boolean, makeDefault: boolean): void;
	(e: "delete", view: ReportView): void;
	(e: "default", view: ReportView): void;
}>();

const name = ref("");
const withFilters = ref(false);

function save() {
	const trimmed = name.value.trim();
	if (!trimmed) return;
	emit("save", trimmed, withFilters.value, false);
	name.value = "";
}
</script>

<template>
	<Popover>
		<PopoverTrigger as-child>
			<Button variant="outline" size="sm" class="h-9 gap-1.5">
				<Bookmark class="h-4 w-4" aria-hidden="true" />
				{{ __("Views") }}
			</Button>
		</PopoverTrigger>
		<PopoverContentStyled align="end" class="w-80">
			<p class="mb-1 text-sm font-semibold text-foreground">{{ __("Saved views") }}</p>
			<p class="mb-2 text-xs text-muted-foreground">
				{{
					__(
						"Saved on this device. A view keeps column order, size, visibility, freezing and sort.",
					)
				}}
			</p>
			<p v-if="views.length === 0" class="py-2 text-sm text-muted-foreground">
				{{ __("No saved views yet.") }}
			</p>
			<ul v-else class="mb-2 max-h-56 space-y-0.5 overflow-auto">
				<li
					v-for="view in views"
					:key="view.id"
					class="flex items-center gap-1 rounded-lg px-1 hover:bg-surface-hover"
				>
					<button
						type="button"
						class="min-w-0 flex-1 truncate rounded py-1.5 text-start text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
						@click="emit('apply', view)"
					>
						{{ view.name }}
						<span v-if="view.filters" class="text-xs text-muted-foreground">
							· {{ __("with filters") }}</span
						>
					</button>
					<Button
						variant="ghost"
						size="icon-sm"
						:aria-pressed="Boolean(view.isDefault)"
						:aria-label="
							view.isDefault ? __('Remove default view') : __('Use {0} as default', [view.name])
						"
						@click="emit('default', view)"
					>
						<Star
							class="h-3.5 w-3.5"
							:class="view.isDefault ? 'fill-warning text-warning' : ''"
						/>
					</Button>
					<Button
						variant="ghost"
						size="icon-sm"
						:aria-label="__('Delete view {0}', [view.name])"
						@click="emit('delete', view)"
					>
						<Trash2 class="h-3.5 w-3.5" />
					</Button>
				</li>
			</ul>
			<form class="space-y-2 border-t border-border pt-2" @submit.prevent="save">
				<Input
					v-model="name"
					:placeholder="__('Name this view')"
					:aria-label="__('View name')"
					class="h-9"
				/>
				<label class="flex items-center gap-2 text-xs text-muted-foreground">
					<Checkbox :checked="withFilters" @update:checked="withFilters = Boolean($event)" />
					{{ __("Include the current filters") }}
				</label>
				<Button type="submit" size="sm" class="h-9 w-full" :disabled="!name.trim()">
					{{ __("Save current view") }}
				</Button>
			</form>
		</PopoverContentStyled>
	</Popover>
</template>
