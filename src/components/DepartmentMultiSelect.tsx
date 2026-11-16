import { useMemo, useState } from "react";
import { Check, ChevronDown, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export type DepartmentChoice = {
  value: string;
  label: string;
  /** How many people are in it, when known. Shown so a choice cannot be empty. */
  count?: number | undefined;
};

/**
 * Pick several departments at once.
 *
 * Empty means everyone, which is the same rule the events and the reports use,
 * so an untouched box is never read as "nobody". The count beside each option is
 * the number of people in that department, which is what stops a typo turning
 * into an event that quietly expects one person.
 */
export function DepartmentMultiSelect({
  id,
  label,
  options,
  value,
  onChange,
  disabled,
  emptyLabel = "Everyone",
  hint,
}: {
  id: string;
  label: string;
  options: DepartmentChoice[];
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  /** What an empty selection means, e.g. "All staff". */
  emptyLabel?: string;
  hint?: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = useMemo(() => new Set(value), [value]);
  const byValue = useMemo(
    () => new Map(options.map((option) => [option.value, option])),
    [options],
  );

  const toggle = (choice: string) => {
    onChange(selected.has(choice) ? value.filter((item) => item !== choice) : [...value, choice]);
  };

  return (
    <div className="space-y-1">
      <label className="text-sm font-medium" htmlFor={id}>
        {label}
      </label>

      {/* Sits outside the popover so "all of them" is always one click away and
          is never hidden behind a search that has not been typed yet. */}
      <Button
        type="button"
        variant={value.length === 0 ? "default" : "outline"}
        size="sm"
        disabled={disabled}
        onClick={() => onChange([])}
        className="w-full justify-start gap-2"
      >
        <Check className={cn("size-4", value.length === 0 ? "opacity-100" : "opacity-0")} />
        {emptyLabel}
      </Button>

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            disabled={disabled}
            className="h-auto min-h-9 w-full justify-between whitespace-normal py-1.5 text-left font-normal"
          >
            <span className={cn("line-clamp-2", value.length === 0 && "text-muted-foreground")}>
              {value.length === 0
                ? "No department chosen"
                : value.length <= 2
                  ? value.map((item) => byValue.get(item)?.label ?? item).join(", ")
                  : `${value.length} departments selected`}
            </span>
            <ChevronDown className="ml-2 size-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="w-[--radix-popover-trigger-width] max-w-[calc(100vw-2rem)] p-0"
          align="start"
          collisionPadding={16}
        >
          <Command>
            <CommandInput placeholder="Search departments…" />
            <CommandList>
              <CommandEmpty>No department matches that.</CommandEmpty>
              <CommandGroup>
                {options.map((option) => (
                  <CommandItem
                    key={option.value}
                    value={option.label}
                    onSelect={() => toggle(option.value)}
                    className="gap-2"
                  >
                    <Checkbox
                      checked={selected.has(option.value)}
                      tabIndex={-1}
                      className="pointer-events-none"
                    />
                    <span className="flex-1 truncate">{option.label}</span>
                    {option.count === undefined ? null : (
                      <span className="text-xs text-muted-foreground">{option.count}</span>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {value.length > 0 ? (
        <div className="flex flex-wrap gap-1 pt-1">
          {value.map((item) => (
            <Badge key={item} variant="secondary" className="gap-1">
              {byValue.get(item)?.label ?? item}
              <button
                type="button"
                aria-label={`Remove ${byValue.get(item)?.label ?? item}`}
                onClick={() => toggle(item)}
                className="rounded-sm hover:text-destructive"
              >
                <X className="size-3" />
              </button>
            </Badge>
          ))}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => onChange([])}
          >
            Clear
          </Button>
        </div>
      ) : null}

      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
