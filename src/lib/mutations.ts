import { useMutation, UseMutationOptions } from "@tanstack/react-query";
import { toast } from "sonner";

/**
 * Wrap a mutation with standardised toast handling.
 *
 * Every mutation in the app follows the same pattern:
 *   - on success: show a success toast with a message
 *   - on error: show an error toast with the error message or a fallback
 *
 * This helper bakes that in so callers only supply the mutation function and
 * the success message. The error handling is automatic and consistent.
 */
export function useMutationWithToast<TVariables, TData, TError = Error>(
  mutationFn: (variables: TVariables) => Promise<TData>,
  options: {
    /** Message shown on success. Can be a string or a function of the returned data. */
    successMessage: string | ((data: TData) => string);
    /** Optional custom error message (otherwise uses the thrown error's message). */
    errorMessage?: string | undefined;
    /** Additional mutation options passed through to useMutation. */
    mutationOptions?: Omit<UseMutationOptions<TData, TError, TVariables>, "mutationFn">;
  },
) {
  const { mutationOptions, ...rest } = options;
  return useMutation({
    mutationFn,
    onSuccess: (
      ...args: Parameters<NonNullable<UseMutationOptions<TData, TError, TVariables>["onSuccess"]>>
    ) => {
      const [data] = args;
      const message =
        typeof rest.successMessage === "function" ? rest.successMessage(data) : rest.successMessage;
      toast.success(message);
      mutationOptions?.onSuccess?.(...args);
    },
    onError: (
      ...args: Parameters<NonNullable<UseMutationOptions<TData, TError, TVariables>["onError"]>>
    ) => {
      const [error] = args;
      const message =
        rest.errorMessage ?? (error instanceof Error ? error.message : "Something went wrong.");
      toast.error(message);
      mutationOptions?.onError?.(...args);
    },
    ...mutationOptions,
  });
}

/** Convenience for mutations that just need a static success message. */
export function useSimpleMutation<TVariables, TData>(
  mutationFn: (variables: TVariables) => Promise<TData>,
  successMessage: string,
  errorMessage?: string,
) {
  return useMutationWithToast(mutationFn, { successMessage, errorMessage });
}

/** Convenience for mutations where the success message depends on the returned data. */
export function useDataMutation<TVariables, TData>(
  mutationFn: (variables: TVariables) => Promise<TData>,
  successMessage: (data: TData) => string,
  errorMessage?: string,
) {
  return useMutationWithToast(mutationFn, { successMessage, errorMessage });
}
