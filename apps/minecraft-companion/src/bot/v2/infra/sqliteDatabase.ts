import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';

export type SqliteDatabase = BetterSqlite3.Database;

export const SQLITE_NATIVE_BINDING_ENV = 'MINECLAW_SQLITE_NATIVE_BINDING';

export function configuredSqliteNativeBinding(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const configured = env[SQLITE_NATIVE_BINDING_ENV]?.trim();
  if (!configured) return undefined;

  const bindingPath = resolve(configured);
  if (!existsSync(bindingPath)) {
    throw new Error(
      `[SQLiteNative] ${SQLITE_NATIVE_BINDING_ENV} 指向不存在的文件：${bindingPath}`,
    );
  }
  return bindingPath;
}

export function openSqliteDatabase(
  filename: string,
  options: BetterSqlite3.Options = {},
): SqliteDatabase {
  const nativeBinding = configuredSqliteNativeBinding();
  return new BetterSqlite3(
    filename,
    nativeBinding ? { ...options, nativeBinding } : options,
  );
}
