/**
 * 共通の Result 型と補助関数。
 *
 * wire.ts / naming.ts / auth.ts が各自定義している Result 型と互換である。
 * 既存ファイルは変更しない。移行は別作業とする。
 *
 * 型の構造は既存 3 ファイルと同一（ok フラグで判別する discriminated union）
 * であるため、型の互換性を保つ。
 */

/** 成功と失敗を型で表現する。例外を投げない代わりにこれを返す。 */
export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

/** 成功値を包む。 */
export function ok<T, E>(value: T): Result<T, E> {
  return { ok: true, value };
}

/** 失敗値を包む。 */
export function err<T, E>(error: E): Result<T, E> {
  return { ok: false, error };
}


