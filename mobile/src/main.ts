import { createApp } from "vue";
import App from "./App.vue";
import "./style.css";

createApp(App).mount("#app");

if (window.visualViewport) {
	const vv = window.visualViewport;
	const typing = () => {
		const el = document.activeElement;
		return !!el && (el.matches("input, textarea, select") || (el as HTMLElement).isContentEditable);
	};
	const update = () =>
		document.documentElement.style.setProperty(
			"--kb",
			typing() ? `${Math.max(0, window.innerHeight - vv.height - vv.offsetTop)}px` : "0px",
		);
	document.addEventListener("focusin", update);
	document.addEventListener("focusout", () => setTimeout(update, 50));
	vv.addEventListener("resize", update);
	vv.addEventListener("scroll", update);
}
