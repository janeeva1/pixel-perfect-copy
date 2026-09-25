import { useMemo, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Upload } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { chunked, digitsOnly, fullName, normalizeName, parseMatric, type PersonType } from "@/lib/attendance";
import { pick, readSpreadsheet } from "@/lib/spreadsheet";
import { useRoles } from "@/lib/useAuth";

export const Route = createFileRoute("/_authenticated/people")({
  head: () => ({
    meta: [
      { title: "Students & staff — Attendance Register" },
      { name: "description", content: "Master list of students and staff, with spreadsheet import." },
      { property: "og:title", content: "Students & staff — Attendance Register" },
      { property: "og:description", content: "Master list of students and staff, with spreadsheet import." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: PeoplePage,
  errorComponent: ({ error }) => <p role="alert">{error.message}</p>,
});

function PeoplePage() {
  const { canEdit } = useRoles();
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [personType, setPersonType] = useState<PersonType>("student");
  const [search, setSearch] = useState("");
  const [progress, setProgress] = useState<string | null>(null);

  const people = useQuery({
    queryKey: ["people", personType, search],
    queryFn: async () => {
      let query = supabase
        .from("people")
        .select("id, person_code, full_name, level, programme, status, machine_key, department_id, departments(code)")
        .eq("person_type", personType)
        .is("deleted_at", null)
        .order("full_name")
        .limit(100);
      if (search.trim()) {
        const term = `%${search.trim()}%`;
        query = query.or(`full_name.ilike.${term},person_code.ilike.${term},machine_key.ilike.${term}`);
      }
      const { data, error } = await query;
      if (error) throw error;
      return data ?? [];
    },
  });

  const total = useQuery({
    queryKey: ["people-count", personType],
    queryFn: async () => {
      const { count, error } = await supabase
        .from("people")
        .select("id", { count: "exact", head: true })
        .eq("person_type", personType)
        .is("deleted_at", null);
      if (error) throw error;
      return count ?? 0;
    },
  });

  const importFile = useMutation({
    mutationFn: async (file: File) => {
      setProgress("Reading file…");
      const { rows } = await readSpreadsheet(file);
      if (rows.length === 0) throw new Error("That file has no data rows.");

      // Departments come from the matric number (e.g. VPG/PGD/ECO/15/1040 → ECO).
      const departmentCodes = new Set<string>();
      for (const row of rows) {
        const code = parseMatric(pick(row, "matric_no", "matric", "matricno")).departmentCode;
        if (code) departmentCodes.add(code.toUpperCase());
      }
      if (departmentCodes.size > 0) {
        setProgress("Saving departments…");
        const { error } = await supabase
          .from("departments")
          .upsert(
            [...departmentCodes].map((code) => ({ code, name: code })),
            { onConflict: "code", ignoreDuplicates: true },
          );
        if (error) throw error;
      }
      const { data: departments } = await supabase.from("departments").select("id, code");
      const departmentByCode = new Map((departments ?? []).map((d) => [d.code.toUpperCase(), d.id]));

      const records = rows
        .map((row) => {
          const sourceId = pick(row, "id", "sn", "serial");
          const last = pick(row, "lname", "surname", "last_name");
          const first = pick(row, "fname", "first_name");
          const middle = pick(row, "mname", "middle_name");
          const name = fullName(last, first, middle) || pick(row, "name", "full_name");
          if (!name) return null;

          if (personType === "student") {
            const matric = pick(row, "matric_no", "matric", "matricno");
            const parsed = parseMatric(matric);
            const code = matric || (sourceId ? `STU-${sourceId}` : null);
            if (!code) return null;
            return {
              person_code: code,
              person_type: "student" as const,
              full_name: name,
              normalized_name: normalizeName(name),
              last_name: last || null,
              first_name: first || null,
              middle_name: middle || null,
              source_id: sourceId || null,
              matric_no: matric || null,
              machine_key: digitsOnly(sourceId),
              programme: parsed.programme,
              level: pick(row, "level") || null,
              department_id: parsed.departmentCode
                ? (departmentByCode.get(parsed.departmentCode.toUpperCase()) ?? null)
                : null,
              status: "active" as const,
            };
          }

          const staffNo = pick(row, "staff_no", "staffno", "staff_number");
          const code = staffNo ? `STF-${sourceId || digitsOnly(staffNo)}` : sourceId ? `STF-${sourceId}` : null;
          if (!code) return null;
          return {
            person_code: code,
            person_type: "staff" as const,
            full_name: name,
            normalized_name: normalizeName(name),
            last_name: last || null,
            first_name: first || null,
            middle_name: middle || null,
            source_id: sourceId || null,
            staff_no: staffNo || null,
            machine_key: digitsOnly(staffNo),
            status: "active" as const,
          };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);

      let saved = 0;
      await chunked(records, 400, async (batch) => {
        const { error } = await supabase.from("people").upsert(batch, { onConflict: "person_code" });
        if (error) throw error;
        saved += batch.length;
        setProgress(`Saved ${saved} of ${records.length} records…`);
      });
      return { saved, skipped: rows.length - records.length };
    },
    onSuccess: (result) => {
      toast.success(`Imported ${result.saved} records${result.skipped ? `, skipped ${result.skipped}` : ""}.`);
      queryClient.invalidateQueries();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Import failed"),
    onSettled: () => {
      setProgress(null);
      if (fileInput.current) fileInput.current.value = "";
    },
  });

  const heading = useMemo(() => (personType === "student" ? "Students" : "Staff"), [personType]);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Students &amp; staff</h1>
        <p className="text-sm text-muted-foreground">
          The master list. Students are recognised by their record number; staff by the digits in their staff number.
        </p>
      </header>

      <Tabs value={personType} onValueChange={(value) => setPersonType(value as PersonType)}>
        <TabsList>
          <TabsTrigger value="student">Students</TabsTrigger>
          <TabsTrigger value="staff">Staff</TabsTrigger>
        </TabsList>
      </Tabs>

      {canEdit && (
        <div className="panel space-y-3 p-5">
          <Label htmlFor="master-file">Import {heading.toLowerCase()} from Excel or CSV</Label>
          <div className="flex flex-wrap items-center gap-3">
            <Input
              id="master-file"
              ref={fileInput}
              type="file"
              accept=".csv,.xls,.xlsx"
              className="max-w-sm"
              disabled={importFile.isPending}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) importFile.mutate(file);
              }}
            />
            {importFile.isPending && (
              <span className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> {progress}
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Expected columns: id, lname, fname, mname and {personType === "student" ? "matric_no, level" : "staff_no"}.
            Re-importing updates existing records instead of duplicating them.
          </p>
        </div>
      )}

      <section className="panel overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-4">
          <h2 className="font-semibold">
            {heading} <span className="text-sm font-normal text-muted-foreground">({total.data ?? 0} total)</span>
          </h2>
          <Input
            placeholder="Search name, number or machine id"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="max-w-xs"
          />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/60 text-left text-xs tracking-wide text-muted-foreground uppercase">
              <tr>
                <th className="p-3">Name</th>
                <th className="p-3">Number</th>
                <th className="p-3">Machine id</th>
                <th className="p-3">{personType === "student" ? "Dept / level" : "Status"}</th>
              </tr>
            </thead>
            <tbody>
              {people.isLoading && (
                <tr>
                  <td colSpan={4} className="p-6 text-center text-muted-foreground">
                    Loading…
                  </td>
                </tr>
              )}
              {people.data?.map((person) => (
                <tr key={person.id} className="border-t border-border">
                  <td className="p-3 font-medium">{person.full_name}</td>
                  <td className="p-3 text-muted-foreground">{person.person_code}</td>
                  <td className="p-3 text-muted-foreground">{person.machine_key || "—"}</td>
                  <td className="p-3 text-muted-foreground">
                    {personType === "student"
                      ? [
                          (person.departments as { code?: string } | null)?.code,
                          person.level ? `Level ${person.level}` : null,
                        ]
                          .filter(Boolean)
                          .join(" · ") || "—"
                      : person.status}
                  </td>
                </tr>
              ))}
              {people.data?.length === 0 && (
                <tr>
                  <td colSpan={4} className="p-6 text-center text-muted-foreground">
                    <Upload className="mx-auto mb-2 size-5" />
                    No records yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {(people.data?.length ?? 0) >= 100 && (
          <p className="border-t border-border p-3 text-xs text-muted-foreground">
            Showing the first 100 matches — refine your search to narrow the list.
          </p>
        )}
      </section>
    </div>
  );
}
