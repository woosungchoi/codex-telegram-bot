export function fullBackupAuthorized(ctx, config) {
  const id = String(ctx?.from?.id ?? "");
  return ctx?.chat?.type === "private" && String(ctx.chat.id) === id
    && config.allowedUserIds?.has(id) === true && config.backupAdminUserIds?.has(id) === true;
}

export function requireFullBackup(ctx, config) {
  if (!fullBackupAuthorized(ctx, config)) throw new Error("Full backups require an authorized administrator in their private chat.");
  return { user: String(ctx.from.id), chat: String(ctx.chat.id) };
}

export function verifyBackupDestination(ctx, config, authorization) {
  const current = requireFullBackup(ctx, config);
  if (current.user !== authorization.user || current.chat !== authorization.chat) throw new Error("Backup destination changed.");
}
