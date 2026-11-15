import { toast, type ToastOptions } from "@/services/toast";

export type { ToastOptions };

export function useToast() {
	const message = (content: string, options?: ToastOptions) => toast.info(content, options);

	return {
		success: toast.success,
		error: toast.error,
		info: toast.info,
		warning: toast.warning,
		message,
		loading: toast.loading,
		update: toast.update,
		promise: toast.promise,
		dismiss: (id?: string | number) => toast.dismiss(id),
		dismissAll: () => toast.dismiss(),
		toast,
	};
}

export function showSuccess(message: string): void {
	toast.success(message);
}

export function showError(message: string): void {
	toast.error(message);
}

export function showWarning(message: string): void {
	toast.warning(message);
}

export function showInfo(message: string): void {
	toast.info(message);
}
