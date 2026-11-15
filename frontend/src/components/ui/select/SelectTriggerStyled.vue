<template>
	<SelectTrigger
		v-bind="$attrs"
		:class="
			cn(
				inputVariants(),
				'items-center justify-between gap-2 whitespace-nowrap text-start read-only:bg-card read-only:shadow-inset data-placeholder:text-muted-foreground data-[state=open]:ring-4 data-[state=open]:ring-primary/12 [&>span]:line-clamp-1',
				$attrs.class as string,
			)
		"
	>
		<slot />
		<SelectIcon as-child>
			<ChevronDown class="h-4 w-4 shrink-0 text-muted-foreground" />
		</SelectIcon>
	</SelectTrigger>
</template>

<script setup lang="ts">
import { SelectTrigger, SelectIcon } from "radix-vue";
import { ChevronDown } from "lucide-vue-next";
import { cn } from "@/lib/utils";
import { inputVariants } from "@/components/ui/input";

defineOptions({
	inheritAttrs: false,
});
</script>
