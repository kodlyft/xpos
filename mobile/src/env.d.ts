/// <reference types="vite/client" />
declare module "*.vue" {
	import type { DefineComponent } from "vue";
	const component: DefineComponent<object, object, unknown>;
	export default component;
}

interface Window {
	xpos?: { _messages?: Record<string, string> };
}

interface ImportMetaEnv {
	readonly VITE_ALLOW_CLEARTEXT?: string;
}
