#!/usr/bin/env bash
# Dart の適合試験を実行し、**実際に試験が走ったこと**を件数で確かめる。
#
# なぜ件数を数えるか: 試験が 0 件でも `dart test` は成功する。「緑」が空虚になる。
#
# なぜ set -e を使わないか: `set -e` の下で `OUTPUT=$(dart test)` と書くと、
# 失敗した時点で終了し、捕捉した出力を表示する前に落ちる（Swift で実際に起きた）。
set -uo pipefail
cd "$(dirname "$0")"

dart pub get > /dev/null 2>&1

OUTPUT=$(dart test --reporter=expanded 2>&1)
STATUS=$?
echo "$OUTPUT"

if [ "$STATUS" -ne 0 ]; then
  echo "FAIL dart test が失敗した（終了状態 ${STATUS}）"
  exit 1
fi

# 「+N: All tests passed!」の N を読む。
PASSED=$(echo "$OUTPUT" | grep -o '+[0-9]*: All tests passed!' | grep -o '[0-9]*' | tail -1)
MIN_TESTS=11
if [ -z "$PASSED" ] || [ "$PASSED" -lt "$MIN_TESTS" ]; then
  echo "FAIL 試験が ${MIN_TESTS} 件以上成功していない（実際 ${PASSED:-0} 件）"
  exit 1
fi
echo "OK: Dart の実装が凍結ベクタとトレースに一致する（${PASSED} 件）"
