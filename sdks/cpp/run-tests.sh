#!/usr/bin/env bash
# C++ の適合試験を構築して実行する。
# 依存を持たないため、コンパイラのみで完結する。
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p build
g++ -std=c++20 -Wall -Wextra -Werror -O1 -o build/conformance tests/conformance.cpp
# ベクタの位置をリポジトリ直下からの相対で渡す。
./build/conformance "../../spec/vectors"
