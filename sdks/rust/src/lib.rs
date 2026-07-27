//! Wheso のクライアント（Rust）。
//!
//! 本 SDK の機能範囲は他の言語と同一である（ADR-0018）。
//! 現時点で実装済みなのは判断コアの一部である。段階は internal の進捗表に従う。
//!
//! 規則:
//!   - パニックしない（unwrap / expect / panic! を使わない）
//!   - unsafe を使わない
//!   - コアで浮動小数点・時刻・乱数・入出力を使わない（lint-policy.md 9 節）
//!   - 数値をコードに書かない。generated から参照する

#![forbid(unsafe_code)]

pub mod fixed;
pub mod generated;
pub mod receiver_core;
pub mod shard_core;
pub mod wire;

pub use fixed::{create_prng, delay_slope, is_degrading, is_recovering, next, trunc_div, CoreError, PrngState, Slope};
pub use wire::{
    compute_discardable, decode_media_message, drop_priority, encode_media_message, MediaMessage, Unit,
    WireError,
};
