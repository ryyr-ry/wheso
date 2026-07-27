#!/usr/bin/env bash
# Swift の適合試験を実行し、実際に試験が走ったことを出力で確かめる。
#
# なぜ確認が必要か: 試験が 0 件でも swift test は成功する。件数を数えて判定する。
set -euo pipefail
cd "$(dirname "$0")"

OUTPUT=$(swift test 2>&1)
echo "$OUTPUT"

PASSED=$(echo "$OUTPUT" | grep -c "' passed" || true)
MIN_TESTS=6
if [ "$PASSED" -lt "$MIN_TESTS" ]; then
  echo "FAIL 試験が ${MIN_TESTS} 件以上成功していない（実際 ${PASSED} 件）"
  exit 1
fi
echo "OK: Swift の実装が凍結ベクタと一致する（${PASSED} 件）"
