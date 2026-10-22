import { useState } from "react";
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
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * One editable field on a person.
 *
 * `kind` is "text" for a free text field and "select" for a field chosen from a
 * fixed list -- the department, which is the registrar's own name, and the
 * level. A select is a dropdown and never a typed value, because a typed
 * department that is one character out is a department nobody is expected at.
 */
export type EditField = {
  key: string;
  label: string;
  kind: "text" | "select";
  value: string | null;
  options?: string[];
  placeholder?: string;
  /** What the empty choice is called, e.g. "No department" or "No level". */
  emptyLabel?: string;
};

export type MasterEditDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  /** The field that cannot be changed, shown so the person can be recognised. */
  identity?: string | undefined;
  fields: EditField[];
  onSave: (values: Record<string, string | null>) => Promise<void>;
};

/**
 * The dialog used to correct one person on the master list. It opens on the
 * person's current values, and the button stays disabled until something has
 * actually changed, so a stray click cannot blank a record.
 *
 * The component is mounted afresh for each person -- the caller gives it a key
 * of the person's id -- so the fields it shows are always the fields of the
 * person being edited, and never a half-finished edit of somebody else.
 */
export function MasterEditDialog({
  open,
  onOpenChange,
  title,
  description,
  identity,
  fields,
  onSave,
}: MasterEditDialogProps) {
  const [values, setValues] = useState<Record<string, string | null>>(() =>
    Object.fromEntries(fields.map((field) => [field.key, field.value])),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const changed = fields.some((field) => values[field.key] !== field.value);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await onSave(values);
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The change could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>

        {identity ? (
          <p className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">{identity}</p>
        ) : null}

        <div className="space-y-4">
          {fields.map((field) => (
            <div key={field.key} className="space-y-1.5">
              <Label htmlFor={`edit-${field.key}`}>{field.label}</Label>
              {field.kind === "select" ? (
                <Select
                  value={values[field.key] ?? "__none__"}
                  onValueChange={(value) =>
                    setValues((prev) => ({
                      ...prev,
                      [field.key]: value === "__none__" ? null : value,
                    }))
                  }
                >
                  <SelectTrigger id={`edit-${field.key}`}>
                    <SelectValue placeholder="Choose one" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">{field.emptyLabel ?? "None"}</SelectItem>
                    {(field.options ?? []).map((option) => (
                      <SelectItem key={option} value={option}>
                        {option}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  id={`edit-${field.key}`}
                  value={values[field.key] ?? ""}
                  placeholder={field.placeholder}
                  onChange={(event) =>
                    setValues((prev) => ({
                      ...prev,
                      [field.key]: event.target.value.trim() === "" ? null : event.target.value,
                    }))
                  }
                />
              )}
            </div>
          ))}
        </div>

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!changed || saving}>
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
