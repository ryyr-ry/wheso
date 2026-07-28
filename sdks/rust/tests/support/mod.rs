//! 疎通試験の補助。tests/ の直下に置くと独立した試験として構築されるため、
//! 下位ディレクトリに置いて `mod support;` で参照する（Cargo は tests の
//! 下位ディレクトリを試験対象にしない）。

pub mod digest;
pub mod websocket;
