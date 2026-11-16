import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Hint } from "@/components/Hint";
import { api } from "@/lib/api";

/**
 * Change an account's name, email or password. For your own account
 * (`self`), the current password is asked for before the email or password
 * changes; an administrator changing someone else's account is not asked.
 */
export function AccountDialog({
  userId,
  email,
  fullName,
  self,
  trigger,
}: {
  userId: string;
  email: string;
  fullName: string | null;
  self: boolean;
  trigger: ReactNode;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    email,
    fullName: fullName ?? "",
    password: "",
    repeat: "",
    current: "",
  });
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<typeof form>) => setForm((value) => ({ ...value, ...patch }));

  async function save() {
    if (form.password && form.password !== form.repeat) {
      toast.error("The two new passwords are not the same.");
      return;
    }
    setBusy(true);
    try {
      await api.updateAccount({
        userId,
        ...(form.email.trim() !== email ? { email: form.email.trim() } : {}),
        ...(form.fullName.trim() !== (fullName ?? "")
          ? { fullName: form.fullName.trim() || null }
          : {}),
        ...(form.password ? { password: form.password } : {}),
        ...(self && form.current ? { currentPassword: form.current } : {}),
      });
      toast.success(self ? "Your account is updated." : "The account is updated.");
      await queryClient.invalidateQueries();
      setOpen(false);
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const needsCurrent = self && (form.email.trim() !== email || form.password !== "");

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next)
          setForm({ email, fullName: fullName ?? "", password: "", repeat: "", current: "" });
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{self ? "My account" : `Edit ${email}`}</DialogTitle>
          <DialogDescription>
            Change the name, the email used to sign in, or the password. Leave the password boxes
            empty to keep the current password.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="account-name">Name</Label>
            <Input
              id="account-name"
              value={form.fullName}
              onChange={(e) => set({ fullName: e.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="account-email">Email</Label>
            <Input
              id="account-email"
              type="email"
              value={form.email}
              onChange={(e) => set({ email: e.target.value })}
            />
            <Hint>Used to sign in.</Hint>
          </div>
          <div className="space-y-1">
            <Label htmlFor="account-password">New password</Label>
            <Input
              id="account-password"
              type="password"
              autoComplete="new-password"
              value={form.password}
              onChange={(e) => set({ password: e.target.value })}
            />
            <Hint>At least 6 characters.</Hint>
          </div>
          {form.password ? (
            <div className="space-y-1">
              <Label htmlFor="account-repeat">New password again</Label>
              <Input
                id="account-repeat"
                type="password"
                autoComplete="new-password"
                value={form.repeat}
                onChange={(e) => set({ repeat: e.target.value })}
              />
            </div>
          ) : null}
          {needsCurrent ? (
            <div className="space-y-1">
              <Label htmlFor="account-current">Your current password</Label>
              <Input
                id="account-current"
                type="password"
                autoComplete="current-password"
                value={form.current}
                onChange={(e) => set({ current: e.target.value })}
              />
              <Hint>Needed to change your own email or password.</Hint>
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button disabled={busy || (needsCurrent && !form.current)} onClick={() => void save()}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
