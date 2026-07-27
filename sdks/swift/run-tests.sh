#!/usr/bin/env bash
# Swift の適合試験を実行し、実際に試験が走ったことを出力で確かめる。
#
# なぜ件数を数えるか: 試験が 0 件でも swift test は成功する。「緑」が空虚になる。
#
# なぜ set -e を使わないか: `set -e` の下で `OUTPUT=$(swift test)` と書くと、
# swift test が失敗した時点でスクリプトが終了し、捕捉した出力を表示する前に落ちる。
# 実際に CI で構築誤りの内容が 1 行も残らない事故が起きた。終了状態は明示的に判定する。
set -uo pipefail
cd "$(dirname "$0")"

OUTPUT=$(swift test 2>&1)
STATUS=$?
echo "$OUTPUT"

if [ "$STATUS" -ne 0 ]; then
  echo "FAIL swift test が失敗した（終了状態 ${STATUS}）"
  exit 1
fi

PASSED=$(echo "$OUTPUT" | grep -c "' passed" || true)
MIN_TESTS=11
if [ "$PASSED" -lt "$MIN_TESTS" ]; then
  echo "FAIL 試験が ${MIN_TESTS} 件以上成功していない（実際 ${PASSED} 件）"
  exit 1
fi
echo "OK: Swift の実装が凍結ベクタと一致する（${PASSED} 件）"
