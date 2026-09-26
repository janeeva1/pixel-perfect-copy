import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { Me } from "@/lib/types";

export const meQueryKey = ["me"] as const;

export type Credentials = { email: string; password: string };
export type SignUpCredentials = Credentials & { fullName: string };

/** Who is signed in. `ready` is false only while the first check is in flight. */
export function useSession() {
  const query = useQuery({
    queryKey: meQueryKey,
    queryFn: api.me,
    staleTime: 30_000,
    retry: false,
  });
  const session: Me | null = query.data ?? null;
  return { session, user: session?.user ?? null, ready: query.isSuccess };
}

export function useAuthActions() {
  const queryClient = useQueryClient();

  const onSignedIn = (me: Me) => {
    queryClient.setQueryData(meQueryKey, me);
  };
  const onSignedOut = () => {
    queryClient.clear();
    queryClient.setQueryData(meQueryKey, null);
  };

  return {
    signIn: useMutation({
      mutationFn: (input: Credentials) => api.signIn(input),
      onSuccess: onSignedIn,
    }),
    signUp: useMutation({
      mutationFn: (input: SignUpCredentials) => api.signUp(input),
      onSuccess: onSignedIn,
    }),
    signOut: useMutation({ mutationFn: () => api.signOut(), onSuccess: onSignedOut }),
  };
}

export function useRoles() {
  const { session, ready } = useSession();
  const roles = session?.roles ?? [];
  return {
    roles,
    isAdmin: roles.includes("admin"),
    canEdit: roles.includes("admin") || roles.includes("operator"),
    loading: !ready,
  };
}
