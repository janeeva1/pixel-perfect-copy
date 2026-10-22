import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { Loader2, ShieldCheck } from "lucide-react";

export const Route = createFileRoute("/setup")({
  head: () => ({
    meta: [
      { title: "First Run Setup — Attendance Register" },
      { name: "description", content: "Create the first administrator account." },
      { property: "og:title", content: "First Run Setup — Attendance Register" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: SetupPage,
  errorComponent: ({ error }) => <p role="alert">{error.message}</p>,
});

function SetupPage() {
  const navigate = useNavigate();
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [fullName, setFullName] = React.useState("");
  const [confirmPassword, setConfirmPassword] = React.useState("");

  const setup = useMutation({
    mutationFn: () => api.setup({ email, password, fullName: fullName.trim() || undefined }),
    onSuccess: () => {
      toast.success("Administrator account created — redirecting to sign in…");
      void navigate({ to: "/auth", replace: true });
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : "Setup failed";
      toast.error(message);
    },
  });

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (password !== confirmPassword) {
      toast.error("Passwords do not match");
      return;
    }
    if (password.length < 8) {
      toast.error("Password must be at least 8 characters");
      return;
    }
    void setup.mutate();
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <div className="panel w-full max-w-md p-8">
        <div className="text-center mb-8">
          <img src="/bmx.png" alt="" className="mx-auto h-14 w-14 object-contain" />
          <h1 className="mt-4 text-2xl font-semibold">First Run Setup</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            No administrator exists yet. Create the first administrator account to begin.
          </p>
        </div>

        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">Full name</Label>
            <Input
              id="name"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              maxLength={120}
              placeholder="Your name"
            />
          </div>
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
              disabled={setup.isPending}
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
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={setup.isPending}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirm">Confirm password</Label>
            <Input
              id="confirm"
              type="password"
              required
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              disabled={setup.isPending}
            />
          </div>
          <Button type="submit" className="w-full" disabled={setup.isPending}>
            {setup.isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Creating administrator…
              </>
            ) : (
              <>
                <ShieldCheck className="mr-2 h-4 w-4" />
                Create administrator
              </>
            )}
          </Button>
        </form>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          This page is only shown until the first administrator is created.
        </p>
      </div>
    </main>
  );
}

function useState<T>(initial: T): [T, (value: T | ((prev: T) => T)) => void] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (useMutation as any)(initial);
}
