#!/usr/bin/env bash
# Kotlin の適合試験を実行し、**実際に試験が走ったこと**を結果ファイルで確かめる。
#
# なぜ確認が必要か: `gradle test --quiet` は何も出力せずに成功する。試験が 0 件でも
# 成功扱いになるため、「緑」が空虚になる。結果 XML の件数を数えて判定する。
set -euo pipefail
cd "$(dirname "$0")"

gradle test --no-daemon

RESULT_DIR="build/test-results/test"
if [ ! -d "$RESULT_DIR" ]; then
  echo "FAIL 試験結果が無い: $RESULT_DIR"
  exit 1
fi

# XML の tests と failures と errors を合計する。
TOTAL=0
FAILED=0
for file in "$RESULT_DIR"/*.xml; do
  [ -e "$file" ] || continue
  tests=$(sed -n 's/.*tests="\([0-9]*\)".*/\1/p' "$file" | head -1)
  failures=$(sed -n 's/.*failures="\([0-9]*\)".*/\1/p' "$file" | head -1)
  errors=$(sed -n 's/.*errors="\([0-9]*\)".*/\1/p' "$file" | head -1)
  TOTAL=$((TOTAL + ${tests:-0}))
  FAILED=$((FAILED + ${failures:-0} + ${errors:-0}))
done

echo "Kotlin 試験 ${TOTAL} 件、失敗 ${FAILED} 件"
MIN_TESTS=8
if [ "$TOTAL" -lt "$MIN_TESTS" ]; then
  echo "FAIL 試験が ${MIN_TESTS} 件以上実行されていない（実際 ${TOTAL} 件）"
  exit 1
fi
if [ "$FAILED" -ne 0 ]; then
  echo "FAIL 失敗した試験がある"
  exit 1
fi
echo "OK: Kotlin の実装が凍結ベクタと一致する"
