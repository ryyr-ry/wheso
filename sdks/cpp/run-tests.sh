#!/usr/bin/env bash
# C++ の適合試験とトレース照合を構築して実行する。
# 依存を持たないため、コンパイラのみで完結する。
#
# なぜ検査件数の下限を見るか: 試験が 0 件でも終了状態は 0 になり得る。
# 「緑」が空虚にならないよう、各実行ファイル側で件数の下限を検査している。
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p build

# 段 A（凍結ベクタ: ワイヤ形式・破棄順位・擬似乱数・整数演算）
g++ -std=c++20 -Wall -Wextra -Werror -O1 -Iinclude -o build/conformance tests/conformance.cpp
# ベクタの位置をリポジトリ直下からの相対で渡す。
./build/conformance "../../spec/vectors"

# 段 A（凍結トレース: 中継ノードと受信ノードの判断コアの完全一致）
g++ -std=c++20 -Wall -Wextra -Werror -O1 -Iinclude -o build/trace tests/trace.cpp
./build/trace "../../spec/vectors"

# 段 A（実データ: 実際に符号化された AV1 と Opus に対する往復と判断）
g++ -std=c++20 -Wall -Wextra -Werror -O1 -Iinclude -o build/real_media tests/real_media.cpp
./build/real_media "../../spec/vectors"
