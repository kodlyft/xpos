<template>
	<div
		class="min-h-screen flex flex-col items-center justify-center bg-linear-to-br from-background to-muted p-4"
	>
		<div class="mb-8 text-center">
			<XposLogo :size="64" class="mx-auto mb-4" />
			<h1 class="text-2xl font-bold text-foreground">X POS</h1>
			<p class="text-muted-foreground text-sm mt-1">Point of Sale System</p>
		</div>

		<Card class="w-full max-w-md">
			<CardHeader class="text-center">
				<CardTitle class="text-xl">Reset Password</CardTitle>
				<CardDescription>
					{{
						authStore.resetEmailSent
							? "Check your email for reset instructions"
							: "Enter your email to receive a password reset link"
					}}
				</CardDescription>
			</CardHeader>
			<CardContent>
				<div v-if="authStore.resetEmailSent" class="space-y-4">
					<div class="p-4 rounded-lg bg-success/10 border border-success/30 text-success">
						<div class="flex items-start gap-3">
							<CheckCircle class="w-5 h-5 mt-0.5 shrink-0" />
							<div class="space-y-1">
								<p class="font-medium">Email Sent Successfully</p>
								<p class="text-sm opacity-90">
									We've sent a password reset link to your email address. Please check your
									inbox and follow the instructions.
								</p>
							</div>
						</div>
					</div>

					<div class="text-center text-sm text-muted-foreground">
						<p>Didn't receive the email?</p>
						<button type="button" class="text-primary hover:underline mt-1" @click="resetForm">
							Try again
						</button>
					</div>

					<Button type="button" variant="outline" class="w-full" @click="goToLogin">
						<ArrowLeft class="w-4 h-4" />
						Back to Sign In
					</Button>
				</div>

				<form v-else @submit.prevent="handleResetPassword" class="space-y-4">
					<div
						v-if="authStore.error"
						class="p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-sm flex items-start gap-2"
					>
						<AlertCircle class="w-4 h-4 mt-0.5 shrink-0" />
						<span>{{ authStore.error }}</span>
					</div>

					<div class="space-y-2">
						<label for="email" class="text-sm font-medium text-foreground"> Email Address </label>
						<div class="relative">
							<Mail
								class="absolute inset-s-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground"
							/>
							<Input
								id="email"
								v-model="email"
								type="email"
								placeholder="Enter your email address"
								class="ps-10"
								:disabled="authStore.isLoading"
								required
								autocomplete="email"
							/>
						</div>
						<p class="text-xs text-muted-foreground">
							Enter the email address associated with your account
						</p>
					</div>

					<Button
						type="submit"
						class="w-full"
						size="lg"
						:disabled="authStore.isLoading || !email || !isValidEmail"
					>
						<Loader2 v-if="authStore.isLoading" class="w-4 h-4 animate-spin" />
						<Send v-else class="w-4 h-4" />
						{{ authStore.isLoading ? "Sending..." : "Send Reset Link" }}
					</Button>

					<div class="text-center">
						<RouterLink
							to="/login"
							class="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
						>
							<ArrowLeft class="w-4 h-4" />
							Back to Sign In
						</RouterLink>
					</div>
				</form>
			</CardContent>
		</Card>
	</div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import { useRouter } from "vue-router";
import { useAuthStore } from "@/stores/authStore";
import { XposLogo } from "@/components/ui/brand";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Mail, Send, ArrowLeft, Loader2, AlertCircle, CheckCircle } from "lucide-vue-next";

const router = useRouter();
const authStore = useAuthStore();

const email = ref("");

const isValidEmail = computed(() => {
	const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
	return emailRegex.test(email.value);
});

async function handleResetPassword() {
	if (!email.value || !isValidEmail.value) return;
	await authStore.sendResetPasswordEmail(email.value);
}

function resetForm() {
	email.value = "";
	authStore.clearError();
	authStore.resetEmailSent = false;
}

function goToLogin() {
	router.push("/login");
}

onMounted(() => {
	authStore.clearError();
	authStore.resetEmailSent = false;
});

onUnmounted(() => {
	authStore.clearError();
});
</script>
