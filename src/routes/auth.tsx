import { useEffect, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuthActions, useSession } from "@/lib/useAuth";

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [
      { title: "Sign in — Attendance Register" },
      {
        name: "description",
        content: "Sign in to manage students, staff and attendance sessions.",
      },
      { property: "og:title", content: "Sign in — Attendance Register" },
      {
        property: "og:description",
        content: "Sign in to manage students, staff and attendance sessions.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: AuthPage,
});

function AuthPage() {
  const navigate = useNavigate();
  const { session, ready } = useSession();
  const { signIn, signUp } = useAuthActions();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullNameValue, setFullNameValue] = useState("");

  const busy = signIn.isPending || signUp.isPending;

  useEffect(() => {
    if (ready && session) navigate({ to: "/dashboard", replace: true });
  }, [ready, session, navigate]);

  function handleError(error: unknown, isSignUp = false) {
    const message = error instanceof Error ? error.message : "Something went wrong";
    const lower = message.toLowerCase();

    if (
      lower.includes("401") ||
      lower.includes("unauthorized") ||
      lower.includes("invalid credentials") ||
      lower.includes("wrong password") ||
      lower.includes("do not match")
    ) {
      toast.error("Invalid email or password");
    } else if (
      lower.includes("404") ||
      lower.includes("not found") ||
      lower.includes("no account") ||
      lower.includes("doesn't exist")
    ) {
      toast.error("No account found with that email");
    } else if (
      lower.includes("409") ||
      lower.includes("conflict") ||
      lower.includes("already exists") ||
      lower.includes("already in use")
    ) {
      toast.error("An account with that email already exists");
    } else if (
      lower.includes("weak") ||
      lower.includes("at least 8") ||
      lower.includes("minimum 8")
    ) {
      toast.error("Password is too weak (minimum 8 characters)");
    } else {
      toast.error(isSignUp ? "Could not create account" : "Could not sign in");
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    try {
      if (mode === "signup") {
        await signUp.mutateAsync({ email, password, fullName: fullNameValue.trim() });
        toast.success("Account created — signing you in…");
      } else {
        await signIn.mutateAsync({ email, password });
        toast.success("Welcome back!");
      }
    } catch (error) {
      handleError(error, mode === "signup");
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <div className="panel w-full max-w-md p-8">
        <img src="/bmx.png" alt="" className="mb-4 h-12 w-12 object-contain" />
        <h1 className="text-2xl font-semibold">
          {mode === "signin" ? "Sign in" : "Create account"}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {mode === "signin"
            ? "Access the attendance register for your institution."
            : "The first account created becomes the administrator."}
        </p>

        <form onSubmit={submit} className="mt-6 space-y-4">
          {mode === "signup" && (
            <div className="space-y-2">
              <Label htmlFor="name">Full name</Label>
              <Input
                id="name"
                value={fullNameValue}
                onChange={(e) => setFullNameValue(e.target.value)}
                maxLength={120}
              />
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              required
              maxLength={255}
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={busy}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              required
              minLength={8}
              maxLength={72}
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
            />
          </div>
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? (
              <>
                <svg className="mr-2 h-4 w-4 animate-spin" viewBox="0 0 24 24">
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                    fill="none"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  />
                </svg>
                {mode === "signin" ? "Signing in…" : "Creating account…"}
              </>
            ) : mode === "signin" ? (
              "Sign in"
            ) : (
              "Create account"
            )}
          </Button>
        </form>

        <button
          type="button"
          className="mt-6 w-full text-sm text-muted-foreground underline-offset-4 hover:underline"
          onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
          disabled={busy}
        >
          {mode === "signin" ? "Need an account? Create one" : "Already have an account? Sign in"}
        </button>
      </div>
    </main>
  );
}
