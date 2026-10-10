import type { Backup } from '@rooster/core/schemas';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, unwrap } from './http';
import { queryKeys } from './query-keys';
import type {
  AdminUser,
  AllowlistEntry,
  AllowlistKind,
  MutationResult,
  QueryResult,
} from './types';

/** `GET /admin/allowlist`. */
export function useAllowlist(): QueryResult<AllowlistEntry[]> {
  return useQuery({
    queryKey: queryKeys.allowlist,
    queryFn: () => unwrap(api.GET('/api/v1/admin/allowlist')),
  });
}

/** `POST /admin/allowlist`. Duplicates fail with `conflict` (409). */
export function useAddAllowlistEntry(): MutationResult<
  { kind: AllowlistKind; value: string },
  AllowlistEntry
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ kind, value }: { kind: AllowlistKind; value: string }) =>
      unwrap(
        api.POST('/api/v1/admin/allowlist', {
          body: kind === 'email' ? { kind, value } : { kind, value },
        }),
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.allowlist }),
  });
}

/** `DELETE /admin/allowlist/:id`. */
export function useRemoveAllowlistEntry(): MutationResult<{ id: string }> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }: { id: string }) => {
      await unwrap(api.DELETE('/api/v1/admin/allowlist/{id}', { params: { path: { id } } }));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.allowlist }),
  });
}

/** `GET /admin/users`. */
export function useAdminUsers(): QueryResult<AdminUser[]> {
  return useQuery({
    queryKey: queryKeys.adminUsers,
    queryFn: () => unwrap(api.GET('/api/v1/admin/users')),
  });
}

/** `PATCH /admin/users/:id` `{disabled}` (disabling revokes the user's sessions). */
export function useSetUserDisabled(): MutationResult<{ userId: string; disabled: boolean }> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ userId, disabled }: { userId: string; disabled: boolean }) => {
      await unwrap(
        api.PATCH('/api/v1/admin/users/{id}', {
          params: { path: { id: userId } },
          body: { disabled },
        }),
      );
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.adminUsers }),
  });
}

/** `GET /admin/backups` (06 §2.10), newest first. */
export function useBackups(): QueryResult<Backup[]> {
  return useQuery({
    queryKey: queryKeys.adminBackups,
    queryFn: async () =>
      [...(await unwrap(api.GET('/api/v1/admin/backups')))].sort(
        (a, b) => b.createdAt - a.createdAt,
      ),
  });
}

/** `POST /admin/backups`: a manual snapshot now. */
export function useCreateBackup(): MutationResult<void, Backup> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => unwrap(api.POST('/api/v1/admin/backups')),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.adminBackups }),
  });
}

/** The download URL of a backup file (`GET /admin/backups/:name`). */
export function backupDownloadUrl(name: string): string {
  return `/api/v1/admin/backups/${encodeURIComponent(name)}`;
}

/**
 * `POST /admin/push-keys/regenerate` (06 §2.10, 08 key rotation): new VAPID keys; every push
 * subscription is dropped, and push stays off until each user turns it on again (ADR 0040).
 */
export function useRegeneratePushKeys(): MutationResult<void> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await unwrap(api.POST('/api/v1/admin/push-keys/regenerate'));
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['push'] }),
  });
}
