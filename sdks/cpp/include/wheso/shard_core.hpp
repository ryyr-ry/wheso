// 中継ノード（shard）の判断コア（C++）。
//
// TypeScript の参照実装（packages/core/src/shard-core.ts）と**同じ入力列から同じ出力列**を
// 返さなければならない（conformance.md 2 節の層 2）。照合は凍結トレースで行う。
// 相違した場合はベクタではなく実装を直す（ADR-0012）。
//
// sans-IO。時刻は入力として受け取り、内部で取得しない。
// 浮動小数点を使わない。例外を投げない。反復順序は決定的にする。
// 依存を持たない（ヘッダのみ）。数値は generated から参照する。
#pragma once

#include <algorithm>
#include <cstdint>
#include <map>
#include <optional>
#include <string>
#include <vector>

#include "wheso/fixed.hpp"
#include "wheso/generated/constants.hpp"
#include "wheso/generated/errors.hpp"
#include "wheso/generated/wire_layout.hpp"
#include "wheso/wire.hpp"

namespace wheso::shard {

// ─────────────────────────────────────────────────────────────────────────────
// 輻輳状態（state-machines.md 3 節）
// ─────────────────────────────────────────────────────────────────────────────

enum class Congestion { Normal, SheddingT2, SheddingT1, SheddingSpatial, KeyOnly };

inline std::string congestion_name(Congestion value) {
  switch (value) {
    case Congestion::Normal:
      return "NORMAL";
    case Congestion::SheddingT2:
      return "SHEDDING_T2";
    case Congestion::SheddingT1:
      return "SHEDDING_T1";
    case Congestion::SheddingSpatial:
      return "SHEDDING_SPATIAL";
    case Congestion::KeyOnly:
      return "KEY_ONLY";
  }
  return "NORMAL";
}

// ─────────────────────────────────────────────────────────────────────────────
// データ型
// ─────────────────────────────────────────────────────────────────────────────

/// はしごの 1 段（ADR-0026）。
struct LadderRung {
  std::int64_t sid = 0;
  std::int64_t width = 0;
  std::int64_t height = 0;
  std::int64_t framerate = 0;
  std::int64_t temporal_layers = 0;
  std::int64_t target_bitrate = 0;
};

/// 送信者が申告した、または観測されたはしご。
struct Ladder {
  std::int64_t from = 0;
  std::int64_t ch = 0;
  std::vector<LadderRung> rungs;
  /// 申告（streamAnnounce）に由来するか。false は観測のみ（fps が分からない）。
  bool announced = false;
};

/// 購読 1 本の状態。判断はすべてここに閉じる（ADR-0025 の 3・5）。
struct Subscription {
  std::int64_t subscriber_id = 0;
  std::int64_t target_id = 0;
  std::int64_t channel = 0;
  std::int64_t max_spatial_id = 0;
  std::int64_t max_temporal_id = 0;
  // 送信窓（congestion.md 2 節）
  std::int64_t window_sid = -1;
  std::int64_t highest_sent = 0;
  std::int64_t highest_acked = 0;
  std::int64_t last_ack_at_ms = 0;
  bool stalled = false;
  // 輻輳（購読単位で適用する）
  Congestion congestion = Congestion::Normal;
  std::int64_t congestion_entered_at = 0;
  std::int64_t tier_penalty = 0;
  // 破棄不可のユニット（優先順位 4・5）を落とした段。落としていなければ −1。
  // 規範 1.4: 順位 4・5 を破棄する場合は次の KEY まで連続して破棄する。
  std::int64_t awaiting_key_sid = -1;
};

/// 受信者ごとの遅延勾配。分子と分母の整数対で持つ（ADR-0017）。
struct ReceiverTrend {
  std::int64_t subscriber_id = 0;
  std::int64_t numerator = 0;
  std::int64_t denominator = 1;
};

/// 送信者ごとの直近の発話時刻（ADR-0024）。
struct SpeakerActivity {
  std::int64_t sender_id = 0;
  std::int64_t last_speech_at_ms = 0;
};

/// 送信者 1 人に指令したエンコーダの上限段（ADR-0022）。
struct EncoderTier {
  std::int64_t target_id = 0;
  std::int64_t tier = 0;
};

/// 受け取った位置。ackUpstream の内容になる。
struct ReceivedMark {
  std::int64_t from = 0;
  std::int64_t ch = 0;
  std::int64_t sid = 0;
  std::int64_t highest_seq = 0;
};

struct State {
  std::vector<std::int64_t> participants;
  std::vector<Subscription> subscriptions;
  std::vector<Ladder> ladders;
  std::vector<ReceiverTrend> trends;
  std::vector<SpeakerActivity> speakers;
  std::vector<EncoderTier> encoder_tiers;
  // ノード全体の予算。転送の可否には使わない（ADR-0025 の 5）。
  std::int64_t budget_bytes_per_sec = constants::NODE_MAX_OUT_BYTES_PER_SEC;
  std::int64_t sent_bytes_in_window = 0;
  std::int64_t sent_messages_in_window = 0;
  std::int64_t window_start_ms = 0;
  bool overload_notified = false;
  // 送信者ごとに受け取った最大の sequenceNumber。timer で ackUpstream として返す。
  std::vector<ReceivedMark> received;
  std::vector<std::string> unexpected_events;
};

// ─────────────────────────────────────────────────────────────────────────────
// 入力イベント
// ─────────────────────────────────────────────────────────────────────────────

enum class EventKind { Media, Subscribe, Ack, StreamAnnounce, Join, Leave, Link, Timer, Budget, Report, KeyframeRequest };

struct Event {
  EventKind kind = EventKind::Timer;
  std::int64_t from = 0;
  std::int64_t to = 0;
  std::int64_t ch = 0;
  std::int64_t sid = 0;
  std::int64_t tid = 0;
  bool key = false;
  std::int64_t bytes = 0;
  std::int64_t flags = 0;
  std::int64_t seq = 0;
  bool want = false;
  std::int64_t max_spatial_id = 0;
  std::int64_t max_temporal_id = 0;
  std::int64_t id = 0;
  std::int64_t peer = 0;
  std::string link_state;
  std::int64_t bytes_per_sec = 0;
  std::vector<std::int64_t> delay_us;
  /// ack の最大受信済み seq
  std::int64_t highest_seq = 0;
  /// streamAnnounce の段
  std::vector<LadderRung> rungs;
  /// keyframeRequest の宛先送信者
  std::int64_t target = 0;
};

// ─────────────────────────────────────────────────────────────────────────────
// 出力コマンド
// ─────────────────────────────────────────────────────────────────────────────

/// 表に無いイベントの記録に 1 件加える。上限を超えたら古い側を捨てる（ADR-0034）。
inline void push_unexpected(std::vector<std::string>& events, const char* name) {
  events.push_back(name);
  const std::size_t limit = static_cast<std::size_t>(constants::MAX_UNEXPECTED_EVENTS);
  if (events.size() > limit) {
    events.erase(events.begin(), events.begin() + static_cast<std::ptrdiff_t>(events.size() - limit));
  }
}

enum class CommandKind { Forward, Drop, SetTier, KeyframeRequest, AckUpstream, Connect, Disconnect, Schedule, Close, Notify };

struct Command {
  CommandKind kind = CommandKind::Forward;
  std::vector<std::int64_t> to;
  std::int64_t priority = 0;
  std::int64_t count = 0;
  std::int64_t code = 0;
  std::int64_t target_id = 0;
  std::int64_t tier = 0;
  std::int64_t peer = 0;
  std::int64_t at = 0;
  // キーフレーム要求の宛先の段（ADR-0033）。段ごとに符号化器が別である。
  std::int64_t channel = 0;
  std::int64_t spatial_id = 0;
  // 上流へ返す受信位置（congestion.md 2 節）。
  std::int64_t highest_seq = 0;
};

struct StepResult {
  State state;
  std::vector<Command> commands;
};

// ─────────────────────────────────────────────────────────────────────────────
// 初期化
// ─────────────────────────────────────────────────────────────────────────────

inline State initial_state(std::int64_t t) {
  State state;
  state.budget_bytes_per_sec = constants::NODE_MAX_OUT_BYTES_PER_SEC;
  state.window_start_ms = t;
  state.overload_notified = false;
  return state;
}

namespace detail {

// ─────────────────────────────────────────────────────────────────────────────
// 順序の比較関数
// ─────────────────────────────────────────────────────────────────────────────

inline bool subscription_less(const Subscription& a, const Subscription& b) {
  if (a.subscriber_id != b.subscriber_id) return a.subscriber_id < b.subscriber_id;
  if (a.target_id != b.target_id) return a.target_id < b.target_id;
  return a.channel < b.channel;
}

inline bool ladder_less(const Ladder& a, const Ladder& b) {
  return a.from != b.from ? a.from < b.from : a.ch < b.ch;
}

// ─────────────────────────────────────────────────────────────────────────────
// はしごの検索
// ─────────────────────────────────────────────────────────────────────────────

inline const Ladder* find_ladder(const State& state, std::int64_t from, std::int64_t ch) {
  for (const Ladder& entry : state.ladders) {
    if (entry.from == from && entry.ch == ch) return &entry;
  }
  return nullptr;
}

// ─────────────────────────────────────────────────────────────────────────────
// 段の選択（ADR-0027 の 3）
// ─────────────────────────────────────────────────────────────────────────────

/// この購読へ渡す段を 1 つ選ぶ。
/// 有効な要求段 = max(0, maxSpatialId − tierPenalty)
/// 選ぶ段 = max{存在する段 | 段 <= 有効な要求段}。該当が無ければ最下段。
inline std::int64_t choose_rung(const State& state, const Subscription& sub) {
  std::int64_t wanted = sub.max_spatial_id - sub.tier_penalty;
  std::int64_t effective = wanted < 0 ? 0 : wanted;
  const Ladder* ladder = find_ladder(state, sub.target_id, sub.channel);
  if (ladder == nullptr || ladder->rungs.empty()) {
    // 段の情報が無い間は要求どおりの段だけを通す。
    return effective;
  }
  std::int64_t best = -1;
  std::int64_t lowest = -1;
  for (const LadderRung& rung : ladder->rungs) {
    if (lowest < 0 || rung.sid < lowest) lowest = rung.sid;
    if (rung.sid <= effective && rung.sid > best) best = rung.sid;
  }
  if (best >= 0) return best;
  return lowest < 0 ? effective : lowest;
}

// ─────────────────────────────────────────────────────────────────────────────
// 送信窓（congestion.md 2 節）
// ─────────────────────────────────────────────────────────────────────────────

/// 未確認のフレーム数。
inline std::int64_t in_flight_frames(const Subscription& sub, std::int64_t seq) {
  std::int64_t highest = seq > sub.highest_sent ? seq : sub.highest_sent;
  std::int64_t in_flight = highest - sub.highest_acked - 1;
  return in_flight < 0 ? 0 : in_flight;
}

/// この購読が渡している段の fps。申告が無ければ 0。
inline std::int64_t framerate_of(const State& state, const Subscription& sub) {
  const Ladder* ladder = find_ladder(state, sub.target_id, sub.channel);
  if (ladder == nullptr || !ladder->announced) return 0;
  std::int64_t chosen = choose_rung(state, sub);
  for (const LadderRung& rung : ladder->rungs) {
    if (rung.sid == chosen) return rung.framerate;
  }
  return 0;
}

/// 送信窓が閉じているか。交差乗算で比較する（浮動小数点禁止）。
inline bool is_window_closed(const State& state, const Subscription& sub, std::int64_t seq, std::int64_t ch) {
  std::int64_t framerate = framerate_of(state, sub);
  if (framerate <= 0) return false;
  // 窓がまだこの連番の空間に無いときは評価しない（ADR-0038）。
  // 購読を張った時点の窓は window_sid = -1 であり、流れている媒体の連番は既に大きい。
  // そのまま比べると最初の 1 件から窓が閉じていると判定され、1 枚も届かない。
  std::int64_t chosen = is_audio_channel(ch) ? 0 : choose_rung(state, sub);
  if (chosen != sub.window_sid) return false;
  std::int64_t in_flight = in_flight_frames(sub, seq);
  return in_flight * 1000 > constants::SEND_WINDOW_MS * framerate;
}

// ─────────────────────────────────────────────────────────────────────────────
// 輻輳状態による破棄
// ─────────────────────────────────────────────────────────────────────────────

/// 輻輳状態に応じた破棄判定。SHEDDING_SPATIAL では段は破棄しない（tierPenalty で行う）。
inline bool should_drop_in_congestion(const Subscription& sub, std::int64_t tid, std::int64_t priority) {
  switch (sub.congestion) {
    case Congestion::Normal:
      return false;
    case Congestion::SheddingT2:
      return priority <= 3;
    case Congestion::SheddingT1:
      return tid >= 1;
    case Congestion::SheddingSpatial:
      return tid >= 1;
    case Congestion::KeyOnly:
      return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// 音声チャネルの判定
// ─────────────────────────────────────────────────────────────────────────────

inline bool is_audio_channel(std::int64_t ch) {
  return ch == static_cast<std::int64_t>(wire_layout::CHANNEL_AUDIO) ||
         ch == static_cast<std::int64_t>(wire_layout::CHANNEL_SCREEN_AUDIO);
}

// ─────────────────────────────────────────────────────────────────────────────
// 音声の選別転送（ADR-0024、ADR-0029 の 2）
// ─────────────────────────────────────────────────────────────────────────────

/// 輻輳の深さ。NORMAL が 0 で、段が深くなるほど大きい。
inline std::int64_t congestion_depth(Congestion state) {
  switch (state) {
    case Congestion::Normal:
      return 0;
    case Congestion::SheddingT2:
      return 1;
    case Congestion::SheddingT1:
      return 2;
    case Congestion::SheddingSpatial:
      return 3;
    case Congestion::KeyOnly:
      return 4;
  }
  return 0;
}

/// この購読者へ同時に転送する音声の本数（ADR-0029 の 2）。
/// 輻輳の段が深いほど減らす。1 本は必ず残す。
inline std::int64_t audio_limit_for(const Subscription& sub) {
  std::int64_t reduced = constants::AUDIO_SELECTIVE_FORWARD_COUNT - congestion_depth(sub.congestion);
  return reduced < constants::AUDIO_SELECTIVE_MIN_COUNT ? constants::AUDIO_SELECTIVE_MIN_COUNT : reduced;
}

/// 購読単位で音声の選別転送を判定する（ADR-0024）。
/// 上限は購読者ごとに決める。帯域が細い購読者へ多くの音声を送らないためである。
inline bool is_audio_forwarded(const State& state, const Subscription& sub,
                               std::int64_t sender_id, std::int64_t t) {
  std::int64_t limit = audio_limit_for(sub);
  std::vector<SpeakerActivity> active;
  for (const SpeakerActivity& entry : state.speakers) {
    if (t - entry.last_speech_at_ms <= constants::AUDIO_SPEAKER_HOLD_MS) {
      active.push_back(entry);
    }
  }
  if (static_cast<std::int64_t>(active.size()) <= limit) {
    // 上限に達していない。全員の音声を通す。DTX の無音で環境音が完全に消えると
    // 通話が不自然になるためである（ADR-0024 の 6）。
    return true;
  }
  std::stable_sort(active.begin(), active.end(),
                   [](const SpeakerActivity& a, const SpeakerActivity& b) {
                     if (a.last_speech_at_ms != b.last_speech_at_ms)
                       return a.last_speech_at_ms > b.last_speech_at_ms;
                     return a.sender_id < b.sender_id;
                   });
  const std::size_t sz_limit = static_cast<std::size_t>(limit);
  for (std::size_t index = 0; index < active.size() && index < sz_limit; ++index) {
    if (active[index].sender_id == sender_id) return true;
  }
  return false;
}

inline std::vector<SpeakerActivity> record_speech(const std::vector<SpeakerActivity>& speakers,
                                                  std::int64_t sender_id, std::int64_t t) {
  std::vector<SpeakerActivity> updated;
  bool replaced = false;
  for (const SpeakerActivity& entry : speakers) {
    if (entry.sender_id == sender_id) {
      updated.push_back(SpeakerActivity{sender_id, t});
      replaced = true;
    } else {
      updated.push_back(entry);
    }
  }
  if (!replaced) {
    updated.push_back(SpeakerActivity{sender_id, t});
    std::stable_sort(updated.begin(), updated.end(),
                     [](const SpeakerActivity& a, const SpeakerActivity& b) {
                       return a.sender_id < b.sender_id;
                     });
  }
  return updated;
}

// ─────────────────────────────────────────────────────────────────────────────
// 輻輳状態の遷移条件（購読単位）
// ─────────────────────────────────────────────────────────────────────────────

/// 送信窓の充填率が閾値を超えているか。fps が分からない間は 0 とみなす。
inline bool fill_greater(const State& state, const Subscription& sub,
                         std::int64_t num, std::int64_t den) {
  std::int64_t framerate = framerate_of(state, sub);
  if (framerate <= 0) return false;
  std::int64_t in_flight = in_flight_frames(sub, sub.highest_sent);
  return in_flight * 1000 * den > num * constants::SEND_WINDOW_MS * framerate;
}

/// 充填率が閾値を下回っているか。fps が不明なら回復を妨げないため条件を満たすとみなす。
inline bool fill_less(const State& state, const Subscription& sub,
                      std::int64_t num, std::int64_t den) {
  std::int64_t framerate = framerate_of(state, sub);
  if (framerate <= 0) return num > 0;
  std::int64_t in_flight = in_flight_frames(sub, sub.highest_sent);
  return in_flight * 1000 * den < num * constants::SEND_WINDOW_MS * framerate;
}

/// この購読者の遅延勾配が閾値を超えているか。他の購読者の勾配は見ない（ADR-0025 の 4）。
inline bool trend_greater(const State& state, const Subscription& sub,
                          std::int64_t num, std::int64_t den) {
  for (const ReceiverTrend& trend : state.trends) {
    if (trend.subscriber_id == sub.subscriber_id) {
      return trend.numerator * den > num * trend.denominator;
    }
  }
  return false;
}

/// 報告が無い場合は回復条件を満たすとみなす。
inline bool trend_less(const State& state, const Subscription& sub,
                       std::int64_t num, std::int64_t den) {
  for (const ReceiverTrend& trend : state.trends) {
    if (trend.subscriber_id == sub.subscriber_id) {
      return trend.numerator * den < num * trend.denominator;
    }
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// 購読 1 本の輻輳状態を評価する
// ─────────────────────────────────────────────────────────────────────────────

struct EvaluateResult {
  Subscription subscription;
  std::vector<Command> commands;
};

inline EvaluateResult evaluate_subscription(const State& state, const Subscription& sub, std::int64_t t) {
  // ヒステリシス: 現状態に入ってから SHEDDING_HYSTERESIS_MS 以内は遷移しない。
  if (t - sub.congestion_entered_at < constants::SHEDDING_HYSTERESIS_MS) {
    return EvaluateResult{sub, {}};
  }

  Congestion next = sub.congestion;
  switch (sub.congestion) {
    case Congestion::Normal:
      if (fill_greater(state, sub, constants::SHARD_UTIL_ENTER_T2_NUM, constants::SHARD_UTIL_ENTER_T2_DEN) ||
          trend_greater(state, sub, constants::SHARD_TREND_ENTER_T2_NUM, constants::SHARD_TREND_ENTER_T2_DEN)) {
        next = Congestion::SheddingT2;
      }
      break;
    case Congestion::SheddingT2:
      if (fill_greater(state, sub, constants::SHARD_UTIL_ENTER_T1_NUM, constants::SHARD_UTIL_ENTER_T1_DEN) ||
          trend_greater(state, sub, constants::SHARD_TREND_ENTER_T1_NUM, constants::SHARD_TREND_ENTER_T1_DEN)) {
        next = Congestion::SheddingT1;
      } else if (fill_less(state, sub, constants::SHARD_UTIL_EXIT_T2_NUM, constants::SHARD_UTIL_EXIT_T2_DEN) &&
                 trend_less(state, sub, constants::SHARD_TREND_EXIT_NUM, constants::SHARD_TREND_EXIT_DEN)) {
        next = Congestion::Normal;
      }
      break;
    case Congestion::SheddingT1:
      if (fill_greater(state, sub, constants::SHARD_UTIL_ENTER_SPATIAL_NUM, constants::SHARD_UTIL_ENTER_SPATIAL_DEN) ||
          trend_greater(state, sub, constants::SHARD_TREND_ENTER_SPATIAL_NUM, constants::SHARD_TREND_ENTER_SPATIAL_DEN)) {
        next = Congestion::SheddingSpatial;
      } else if (fill_less(state, sub, constants::SHARD_UTIL_EXIT_T1_NUM, constants::SHARD_UTIL_EXIT_T1_DEN) &&
                 trend_less(state, sub, constants::SHARD_TREND_EXIT_NUM, constants::SHARD_TREND_EXIT_DEN)) {
        next = Congestion::SheddingT2;
      }
      break;
    case Congestion::SheddingSpatial:
      if (fill_greater(state, sub, constants::SHARD_UTIL_ENTER_KEY_ONLY_NUM, constants::SHARD_UTIL_ENTER_KEY_ONLY_DEN) ||
          trend_greater(state, sub, constants::SHARD_TREND_ENTER_KEY_ONLY_NUM, constants::SHARD_TREND_ENTER_KEY_ONLY_DEN)) {
        next = Congestion::KeyOnly;
      } else if (fill_less(state, sub, constants::SHARD_UTIL_EXIT_SPATIAL_NUM, constants::SHARD_UTIL_EXIT_SPATIAL_DEN) &&
                 trend_less(state, sub, constants::SHARD_TREND_EXIT_NUM, constants::SHARD_TREND_EXIT_DEN)) {
        next = Congestion::SheddingT1;
      }
      break;
    case Congestion::KeyOnly:
      if (fill_less(state, sub, constants::SHARD_UTIL_EXIT_KEY_ONLY_NUM, constants::SHARD_UTIL_EXIT_KEY_ONLY_DEN) &&
          trend_less(state, sub, constants::SHARD_TREND_EXIT_KEY_ONLY_NUM, constants::SHARD_TREND_EXIT_KEY_ONLY_DEN)) {
        next = Congestion::SheddingSpatial;
      }
      break;
  }

  if (next == sub.congestion) {
    return EvaluateResult{sub, {}};
  }

  // SHEDDING_SPATIAL 以降は段を 1 つ下げる（ADR-0027 の 4）。
  std::int64_t penalty = (next == Congestion::SheddingSpatial || next == Congestion::KeyOnly) ? 1 : 0;
  Subscription updated = sub;
  updated.congestion = next;
  updated.congestion_entered_at = t;
  updated.tier_penalty = penalty;

  std::vector<Command> commands;
  if (penalty != sub.tier_penalty) {
    // 購読者へ setTier を送ってはならない（ADR-0033）。段の変化は媒体の spatialId で伝わる。
    Command kf_req;
    kf_req.kind = CommandKind::KeyframeRequest;
    kf_req.target_id = sub.target_id;
    kf_req.channel = sub.channel;
    kf_req.spatial_id = choose_rung(state, updated);
    commands.push_back(kf_req);
  }
  return EvaluateResult{updated, commands};
}

/// すべての購読の輻輳状態を評価する。
inline StepResult evaluate_all(const State& state, std::int64_t t) {
  std::vector<Command> commands;
  std::vector<Subscription> subscriptions;
  for (const Subscription& sub : state.subscriptions) {
    EvaluateResult result = evaluate_subscription(state, sub, t);
    subscriptions.push_back(result.subscription);
    for (const Command& cmd : result.commands) commands.push_back(cmd);
  }
  State next = state;
  next.subscriptions = subscriptions;
  return StepResult{next, commands};
}

// ─────────────────────────────────────────────────────────────────────────────
// ノード全体の予算超過通知（ADR-0025 の 5）
// ─────────────────────────────────────────────────────────────────────────────

inline StepResult notify_node_overload(const State& state, std::int64_t t) {
  if (state.overload_notified) return StepResult{state, {}};
  std::int64_t elapsed = t - state.window_start_ms;
  if (elapsed <= 0) return StepResult{state, {}};
  bool messages_over = state.sent_messages_in_window * 1000 > constants::NODE_MAX_OUT_MESSAGES_PER_SEC * elapsed;
  bool bytes_over = state.sent_bytes_in_window * 1000 > state.budget_bytes_per_sec * elapsed;
  if (!messages_over && !bytes_over) return StepResult{state, {}};
  State next = state;
  next.overload_notified = true;
  Command notify;
  notify.kind = CommandKind::Notify;
  notify.code = errors::E_NODE_OVERLOADED_CLOSE_CODE;
  return StepResult{next, {notify}};
}

// ─────────────────────────────────────────────────────────────────────────────
// 窓のリセット
// ─────────────────────────────────────────────────────────────────────────────

inline State maybe_reset_window(const State& state, std::int64_t t) {
  if (t - state.window_start_ms < constants::SHARD_UTIL_WINDOW_MS) return state;
  State next = state;
  next.sent_bytes_in_window = 0;
  next.sent_messages_in_window = 0;
  next.window_start_ms = t;
  next.overload_notified = false;
  return next;
}

// ─────────────────────────────────────────────────────────────────────────────
// はしごの観測
// ─────────────────────────────────────────────────────────────────────────────

inline LadderRung observed_rung(std::int64_t sid) {
  return LadderRung{sid, 0, 0, 0, 0, 0};
}

/// 観測からはしごを補う。申告前でもユニットの spatialId から段の集合が分かる。
inline State observe_ladder(const State& state, const Event& event) {
  if (is_audio_channel(event.ch)) return state;
  const Ladder* existing = find_ladder(state, event.from, event.ch);
  if (existing != nullptr) {
    if (existing->announced) return state;
    for (const LadderRung& rung : existing->rungs) {
      if (rung.sid == event.sid) return state;
    }
    // 新しい段を追加する。
    std::vector<LadderRung> rungs = existing->rungs;
    rungs.push_back(observed_rung(event.sid));
    std::sort(rungs.begin(), rungs.end(), [](const LadderRung& a, const LadderRung& b) {
      return a.sid < b.sid;
    });
    State next = state;
    next.ladders.clear();
    for (const Ladder& entry : state.ladders) {
      if (entry.from == event.from && entry.ch == event.ch) {
        Ladder updated = entry;
        updated.rungs = rungs;
        next.ladders.push_back(updated);
      } else {
        next.ladders.push_back(entry);
      }
    }
    std::sort(next.ladders.begin(), next.ladders.end(), ladder_less);
    return next;
  }
  // 新規の観測はしご。
  Ladder created;
  created.from = event.from;
  created.ch = event.ch;
  created.rungs = {observed_rung(event.sid)};
  created.announced = false;
  State next = state;
  next.ladders.push_back(created);
  std::sort(next.ladders.begin(), next.ladders.end(), ladder_less);
  return next;
}

// ─────────────────────────────────────────────────────────────────────────────
// エンコーダ指令（ADR-0022）
// ─────────────────────────────────────────────────────────────────────────────

inline StepResult with_encoder_tiers(const State& state) {
  std::vector<std::int64_t> targets;
  for (const Subscription& sub : state.subscriptions) {
    if (std::find(targets.begin(), targets.end(), sub.target_id) == targets.end()) {
      targets.push_back(sub.target_id);
    }
  }
  std::sort(targets.begin(), targets.end());

  std::vector<EncoderTier> next_tiers;
  std::vector<Command> commands;
  for (std::int64_t target_id : targets) {
    std::int64_t tier = 0;
    for (const Subscription& sub : state.subscriptions) {
      if (sub.target_id == target_id && sub.max_spatial_id > tier) {
        tier = sub.max_spatial_id;
      }
    }
    next_tiers.push_back(EncoderTier{target_id, tier});
    bool changed = true;
    for (const EncoderTier& prev : state.encoder_tiers) {
      if (prev.target_id == target_id) {
        changed = prev.tier != tier;
        break;
      }
    }
    if (changed) {
      Command cmd;
      cmd.kind = CommandKind::SetTier;
      cmd.target_id = target_id;
      cmd.tier = tier;
      commands.push_back(cmd);
    }
  }
  State next = state;
  next.encoder_tiers = next_tiers;
  return StepResult{next, commands};
}

// ─────────────────────────────────────────────────────────────────────────────
// 購読 1 本に対する転送の可否
// ─────────────────────────────────────────────────────────────────────────────

struct SubscriptionDecision {
  Subscription subscription;
  bool forward = false;
  /// 破棄として報告する優先順位。-1 は報告しないことを意味する。
  std::int64_t drop_priority = -1;
  /// 送信者へキーフレームを要求するか（規範 1.4）。
  /// 順位 4・5 を落としたときだけ真になる。1〜3 では立てない。
  bool request_keyframe = false;
};

/// 破棄する。順位 4・5 なら次の KEY までの連続破棄を始め、キーフレームを要求する（規範 1.4）。
/// 順位 1〜3（破棄可能なユニット）では連鎖を始めず、要求も作らない。
inline SubscriptionDecision drop_with_chain(const Subscription& sub, const Event& event, std::int64_t priority) {
  bool breaks_chain = (priority == 4 || priority == 5);
  if (!breaks_chain) {
    return SubscriptionDecision{sub, false, priority, false};
  }
  Subscription updated = sub;
  updated.awaiting_key_sid = event.sid;
  return SubscriptionDecision{updated, false, priority, true};
}

/// 転送する。段が変わっていれば窓を作り直す。
inline SubscriptionDecision forward_decision(const State& state, const Subscription& sub, const Event& event) {
  std::int64_t chosen = is_audio_channel(event.ch) ? 0 : choose_rung(state, sub);
  if (chosen != sub.window_sid) {
    // 渡す段が変わった。seq の空間が変わるため窓を作り直す。
    Subscription updated = sub;
    updated.window_sid = chosen;
    updated.highest_sent = event.seq;
    updated.highest_acked = event.seq - 1;
    return SubscriptionDecision{updated, true, -1, false};
  }
  Subscription updated = sub;
  if (event.seq > sub.highest_sent) updated.highest_sent = event.seq;
  return SubscriptionDecision{updated, true, -1, false};
}

inline SubscriptionDecision decide_for_subscription(const State& state, const Subscription& sub,
                                                    const Event& event,
                                                    std::optional<std::int64_t> priority,
                                                    std::int64_t t) {
  // 1. ack が途絶えている → 渡さない
  if (sub.stalled) {
    return SubscriptionDecision{sub, false, -1, false};
  }

  // 音声の選別転送（ADR-0024、ADR-0029 の 2）。
  // 本数は購読者ごとに決める。帯域が細い購読者へ多くの音声を送らないためである。
  if (is_audio_channel(event.ch) && !is_audio_forwarded(state, sub, event.from, t)) {
    // 輻輳による破棄ではないため priority は 0 とする（ADR-0024 の 5）。
    return SubscriptionDecision{sub, false, 0, false};
  }

  // 音声は段を持たない。段の選択は映像のみ。
  if (!is_audio_channel(event.ch)) {
    // 2. 段の選択に合わない → 渡さない
    std::int64_t chosen = choose_rung(state, sub);
    if (event.sid != chosen) {
      return SubscriptionDecision{sub, false, -1, false};
    }
    // 3. temporalId の超過 → 渡さない
    if (event.tid > sub.max_temporal_id) {
      return SubscriptionDecision{sub, false, -1, false};
    }
  }

  bool must_forward = !priority.has_value();
  bool is_key = (event.flags & static_cast<std::int64_t>(wire_layout::FLAG_KEY)) != 0;

  // 参照連鎖が切れている間は、次の KEY まで落とし続ける（規範 1.4）。
  // 順位 4・5 を 1 件落とした後に後続を渡すと、復号器は参照の無いフレームを受け取り
  // 出力を止める。落とし続ければ復号器は「キーフレーム待ち」に入り、要求で復帰する。
  if (!is_audio_channel(event.ch) && sub.awaiting_key_sid == event.sid) {
    if (!is_key) {
      // 落とす。要求は最初の 1 回で送っているため繰り返さない。
      return SubscriptionDecision{sub, false, priority.has_value() ? priority.value() : -1, false};
    }
    // KEY が来た。参照連鎖が回復するため、待ちを解いて渡す。
    Subscription cleared = sub;
    cleared.awaiting_key_sid = -1;
    return forward_decision(state, cleared, event);
  }

  // 4. 輻輳状態による破棄
  if (!must_forward && should_drop_in_congestion(sub, event.tid, priority.value())) {
    return drop_with_chain(sub, event, priority.value());
  }

  // 5. 送信窓が閉じている
  if (!must_forward && is_window_closed(state, sub, event.seq, event.ch)) {
    return drop_with_chain(sub, event, priority.value());
  }

  // 6. 渡す
  return forward_decision(state, sub, event);
}

// ─────────────────────────────────────────────────────────────────────────────
// メディアの処理
// ─────────────────────────────────────────────────────────────────────────────

/// 受け取った位置を更新する。後戻りする値では更新しない。順序は from, ch, sid の昇順。
inline State mark_received(const State& state, const Event& event) {
  if (event.seq <= 0) return state;
  for (const ReceivedMark& mark : state.received) {
    if (mark.from == event.from && mark.ch == event.ch && mark.sid == event.sid &&
        mark.highest_seq >= event.seq) {
      return state;
    }
  }
  State next = state;
  next.received.clear();
  for (const ReceivedMark& mark : state.received) {
    if (!(mark.from == event.from && mark.ch == event.ch && mark.sid == event.sid)) {
      next.received.push_back(mark);
    }
  }
  ReceivedMark added;
  added.from = event.from;
  added.ch = event.ch;
  added.sid = event.sid;
  added.highest_seq = event.seq;
  next.received.push_back(added);
  std::sort(next.received.begin(), next.received.end(), [](const ReceivedMark& a, const ReceivedMark& b) {
    if (a.from != b.from) return a.from < b.from;
    if (a.ch != b.ch) return a.ch < b.ch;
    return a.sid < b.sid;
  });
  return next;
}

inline StepResult handle_media(const State& state, const Event& event, std::int64_t t) {
  State windowed = observe_ladder(maybe_reset_window(state, t), event);

  // 音声で ACTIVE_SPEAKER が立っていれば発話時刻を記録する。
  // 記録は選別の前に行う。今まさに発話している送信者の音声は通す必要がある。
  bool audio = is_audio_channel(event.ch);
  bool speaking = (event.flags & static_cast<std::int64_t>(wire_layout::FLAG_ACTIVE_SPEAKER)) != 0;
  if (audio && speaking) {
    windowed.speakers = record_speech(windowed.speakers, event.from, t);
  }

  // 破棄優先順位を計算する。
  std::optional<std::uint8_t> raw_priority =
      drop_priority(static_cast<std::uint8_t>(event.ch), static_cast<std::uint8_t>(event.flags));
  std::optional<std::int64_t> priority;
  if (raw_priority.has_value()) priority = static_cast<std::int64_t>(raw_priority.value());

  // 受け取った位置を記録する。ack はタイマーでまとめて返す（congestion.md 2 節）。
  windowed = mark_received(windowed, event);

  std::vector<std::int64_t> targets;
  std::map<std::int64_t, std::int64_t> dropped;
  std::vector<Subscription> next_subscriptions;
  // 参照連鎖が切れた購読が 1 つでもあれば、送信者へキーフレームを 1 度だけ要求する
  // （規範 1.4）。購読ごとに出すと同じ要求が並ぶ。要求は段ごとに 1 件で足りる。
  bool wants_keyframe = false;

  for (const Subscription& sub : windowed.subscriptions) {
    if (sub.target_id != event.from || sub.channel != event.ch) {
      next_subscriptions.push_back(sub);
      continue;
    }
    SubscriptionDecision decision = decide_for_subscription(windowed, sub, event, priority, t);
    next_subscriptions.push_back(decision.subscription);
    if (decision.request_keyframe) {
      wants_keyframe = true;
    }
    if (decision.forward) {
      targets.push_back(sub.subscriber_id);
    } else if (decision.drop_priority >= 0) {
      dropped[decision.drop_priority] += 1;
    }
  }

  std::sort(targets.begin(), targets.end());

  std::vector<Command> commands;
  // 破棄は優先順位の昇順で 1 件ずつ報告する。map は key の昇順で反復する。
  for (const auto& [prio, cnt] : dropped) {
    if (cnt > 0) {
      Command drop;
      drop.kind = CommandKind::Drop;
      drop.priority = prio;
      drop.count = cnt;
      commands.push_back(drop);
    }
  }
  // 破棄の報告の後に置く（順序を固定しないとトレースの完全一致が壊れる）。
  if (wants_keyframe) {
    Command kf_req;
    kf_req.kind = CommandKind::KeyframeRequest;
    kf_req.target_id = event.from;
    kf_req.channel = event.ch;
    kf_req.spatial_id = event.sid;
    commands.push_back(kf_req);
  }

  if (targets.empty()) {
    windowed.subscriptions = next_subscriptions;
    return StepResult{windowed, commands};
  }

  Command forward;
  forward.kind = CommandKind::Forward;
  forward.to = targets;
  commands.push_back(forward);

  // ノード全体の予算を計上する。
  std::int64_t msg_cost = static_cast<std::int64_t>(targets.size());
  windowed.subscriptions = next_subscriptions;
  windowed.sent_messages_in_window += msg_cost;
  windowed.sent_bytes_in_window += msg_cost * event.bytes;
  StepResult overload = notify_node_overload(windowed, t);
  for (const Command& cmd : overload.commands) commands.push_back(cmd);
  return StepResult{overload.state, commands};
}

// ─────────────────────────────────────────────────────────────────────────────
// 購読の処理
// ─────────────────────────────────────────────────────────────────────────────

inline StepResult handle_subscribe(const State& state, const Event& event, std::int64_t t) {
  // 既存の同一キーを除く。
  std::vector<Subscription> rest;
  const Subscription* existing = nullptr;
  for (const Subscription& s : state.subscriptions) {
    if (s.subscriber_id == event.from && s.target_id == event.to && s.channel == event.ch) {
      existing = &s;
    } else {
      rest.push_back(s);
    }
  }
  if (!event.want) {
    std::sort(rest.begin(), rest.end(), subscription_less);
    State next = state;
    next.subscriptions = rest;
    return with_encoder_tiers(next);
  }
  // 購読を張り直したときは送信窓と輻輳状態を引き継ぎつつ lastAckAtMs を更新する。
  Subscription created;
  created.subscriber_id = event.from;
  created.target_id = event.to;
  created.channel = event.ch;
  created.max_spatial_id = event.max_spatial_id;
  created.max_temporal_id = event.max_temporal_id;
  created.window_sid = existing ? existing->window_sid : -1;
  created.highest_sent = existing ? existing->highest_sent : 0;
  created.highest_acked = existing ? existing->highest_acked : 0;
  created.last_ack_at_ms = t;
  created.stalled = false;
  created.congestion = existing ? existing->congestion : Congestion::Normal;
  created.congestion_entered_at = existing ? existing->congestion_entered_at : t;
  created.tier_penalty = existing ? existing->tier_penalty : 0;
  created.awaiting_key_sid = existing ? existing->awaiting_key_sid : -1;
  rest.push_back(created);
  std::sort(rest.begin(), rest.end(), subscription_less);
  State next = state;
  next.subscriptions = rest;
  return with_encoder_tiers(next);
}

// ─────────────────────────────────────────────────────────────────────────────
// ack の処理
// ─────────────────────────────────────────────────────────────────────────────

inline StepResult handle_ack(const State& state, const Event& event, std::int64_t t) {
  // 購読を見つける。
  std::int64_t target_index = -1;
  for (std::size_t i = 0; i < state.subscriptions.size(); ++i) {
    const Subscription& s = state.subscriptions[i];
    if (s.subscriber_id == event.from && s.target_id == event.to && s.channel == event.ch) {
      target_index = static_cast<std::int64_t>(i);
      break;
    }
  }
  if (target_index < 0) {
    // 対応する購読が無い。無視して記録する。
    State next = state;
    push_unexpected(next.unexpected_events, "ack");
    return StepResult{next, {}};
  }
  const Subscription& target = state.subscriptions[static_cast<std::size_t>(target_index)];
  if (event.sid != target.window_sid) {
    // 渡していない段への ack。段を変えた直後に古い ack が届くことがある。
    State next = state;
    push_unexpected(next.unexpected_events, "ack");
    return StepResult{next, {}};
  }
  // 後戻りする ack は無視する。
  std::int64_t highest_acked = event.highest_seq > target.highest_acked ? event.highest_seq : target.highest_acked;
  Subscription updated = target;
  updated.highest_acked = highest_acked;
  updated.last_ack_at_ms = t;
  updated.stalled = false;
  State next = state;
  next.subscriptions.clear();
  for (std::size_t i = 0; i < state.subscriptions.size(); ++i) {
    if (static_cast<std::int64_t>(i) == target_index) {
      next.subscriptions.push_back(updated);
    } else {
      next.subscriptions.push_back(state.subscriptions[i]);
    }
  }
  std::sort(next.subscriptions.begin(), next.subscriptions.end(), subscription_less);
  // ack で未確認量が減るため、輻輳状態を再評価する。
  return evaluate_all(next, t);
}

// ─────────────────────────────────────────────────────────────────────────────
// streamAnnounce の処理
// ─────────────────────────────────────────────────────────────────────────────

inline StepResult handle_stream_announce(const State& state, const Event& event, std::int64_t t) {
  std::vector<LadderRung> rungs = event.rungs;
  std::sort(rungs.begin(), rungs.end(), [](const LadderRung& a, const LadderRung& b) {
    return a.sid < b.sid;
  });
  std::vector<Ladder> rest;
  for (const Ladder& entry : state.ladders) {
    if (!(entry.from == event.from && entry.ch == event.ch)) {
      rest.push_back(entry);
    }
  }
  Ladder ladder;
  ladder.from = event.from;
  ladder.ch = event.ch;
  ladder.rungs = rungs;
  ladder.announced = true;
  rest.push_back(ladder);
  std::sort(rest.begin(), rest.end(), ladder_less);
  State next = state;
  next.ladders = rest;
  // はしごが変わると選ぶ段と fps が変わるため、輻輳状態を再評価する。
  return evaluate_all(next, t);
}

// ─────────────────────────────────────────────────────────────────────────────
// 参加と退出
// ─────────────────────────────────────────────────────────────────────────────

inline StepResult handle_join(const State& state, std::int64_t id) {
  if (std::find(state.participants.begin(), state.participants.end(), id) != state.participants.end()) {
    return StepResult{state, {}};
  }
  State next = state;
  next.participants.push_back(id);
  std::sort(next.participants.begin(), next.participants.end());
  return StepResult{next, {}};
}

inline StepResult handle_leave(const State& state, std::int64_t id) {
  State next = state;
  next.participants.clear();
  for (std::int64_t v : state.participants) {
    if (v != id) next.participants.push_back(v);
  }
  next.subscriptions.clear();
  for (const Subscription& s : state.subscriptions) {
    if (s.subscriber_id != id && s.target_id != id) next.subscriptions.push_back(s);
  }
  next.trends.clear();
  for (const ReceiverTrend& trend : state.trends) {
    if (trend.subscriber_id != id) next.trends.push_back(trend);
  }
  next.received.clear();
  for (const ReceivedMark& mark : state.received) {
    if (mark.from != id) next.received.push_back(mark);
  }
  next.ladders.clear();
  for (const Ladder& entry : state.ladders) {
    if (entry.from != id) next.ladders.push_back(entry);
  }
  next.speakers.clear();
  for (const SpeakerActivity& entry : state.speakers) {
    if (entry.sender_id != id) next.speakers.push_back(entry);
  }
  next.encoder_tiers.clear();
  for (const EncoderTier& entry : state.encoder_tiers) {
    if (entry.target_id != id) next.encoder_tiers.push_back(entry);
  }
  return with_encoder_tiers(next);
}

// ─────────────────────────────────────────────────────────────────────────────
// タイマー・予算・報告
// ─────────────────────────────────────────────────────────────────────────────

/// ack が途絶えた購読を検出する（congestion.md 7 節）。
inline StepResult detect_ack_timeout(const State& state, std::int64_t t) {
  std::vector<Command> commands;
  std::vector<Subscription> subscriptions;
  for (const Subscription& sub : state.subscriptions) {
    bool outstanding = sub.highest_sent > sub.highest_acked;
    if (!sub.stalled && !outstanding) {
      // 未確認が無い間は時計を進める（ADR-0041）。
      // 「無通信」と「無応答」を区別するため、未確認の媒体が無い購読は
      // last_ack_at_ms を現在時刻で更新する。
      Subscription updated = sub;
      updated.last_ack_at_ms = t;
      subscriptions.push_back(updated);
      continue;
    }
    if (sub.stalled || t - sub.last_ack_at_ms < constants::ACK_TIMEOUT_MS) {
      subscriptions.push_back(sub);
      continue;
    }
    Subscription stalled = sub;
    stalled.stalled = true;
    subscriptions.push_back(stalled);
    Command disconnect;
    disconnect.kind = CommandKind::Disconnect;
    disconnect.peer = sub.subscriber_id;
    commands.push_back(disconnect);
  }
  State next = state;
  next.subscriptions = subscriptions;
  return StepResult{next, commands};
}

inline StepResult handle_timer(const State& state, std::int64_t t) {
  State windowed = maybe_reset_window(state, t);
  StepResult stalled = detect_ack_timeout(windowed, t);
  StepResult evaluated = evaluate_all(stalled.state, t);
  std::vector<Command> commands = stalled.commands;
  for (const Command& cmd : evaluated.commands) commands.push_back(cmd);
  // 上流（送信ノード）へ受信位置を返す。返さないと送信ノードの窓が開かない。
  for (const ReceivedMark& mark : evaluated.state.received) {
    Command ack;
    ack.kind = CommandKind::AckUpstream;
    ack.target_id = mark.from;
    ack.channel = mark.ch;
    ack.spatial_id = mark.sid;
    ack.highest_seq = mark.highest_seq;
    commands.push_back(ack);
  }
  return StepResult{evaluated.state, commands};
}

inline StepResult handle_budget(const State& state, const Event& event, std::int64_t t) {
  State next = state;
  next.budget_bytes_per_sec = event.bytes_per_sec;
  return evaluate_all(next, t);
}

inline StepResult handle_report(const State& state, const Event& event, std::int64_t t) {
  Slope slope = delay_slope(event.delay_us);
  std::vector<ReceiverTrend> rest;
  for (const ReceiverTrend& trend : state.trends) {
    if (trend.subscriber_id != event.from) rest.push_back(trend);
  }
  rest.push_back(ReceiverTrend{event.from, slope.numerator, slope.denominator});
  std::sort(rest.begin(), rest.end(), [](const ReceiverTrend& a, const ReceiverTrend& b) {
    return a.subscriber_id < b.subscriber_id;
  });
  State next = state;
  next.trends = rest;
  return evaluate_all(next, t);
}

/// 購読者のキーフレーム要求を送信者への要求へ直す（ADR-0039）。
/// 購読が無い相手への要求は無視して記録する。
inline StepResult handle_keyframe_request(const State& state, const Event& event) {
  bool subscribed = false;
  for (const Subscription& sub : state.subscriptions) {
    if (sub.subscriber_id == event.from && sub.target_id == event.target && sub.channel == event.ch) {
      subscribed = true;
      break;
    }
  }
  if (!subscribed) {
    State next = state;
    push_unexpected(next.unexpected_events, "keyframeRequest");
    return StepResult{next, {}};
  }
  Command kf_req;
  kf_req.kind = CommandKind::KeyframeRequest;
  kf_req.target_id = event.target;
  kf_req.channel = event.ch;
  kf_req.spatial_id = event.sid;
  return StepResult{state, {kf_req}};
}

}  // namespace detail

// ─────────────────────────────────────────────────────────────────────────────
// ステップ関数
// ─────────────────────────────────────────────────────────────────────────────

inline StepResult step(const State& state, const Event& event, std::int64_t t) {
  switch (event.kind) {
    case EventKind::Media:
      return detail::handle_media(state, event, t);
    case EventKind::Subscribe:
      return detail::handle_subscribe(state, event, t);
    case EventKind::Ack:
      return detail::handle_ack(state, event, t);
    case EventKind::StreamAnnounce:
      return detail::handle_stream_announce(state, event, t);
    case EventKind::Join:
      return detail::handle_join(state, event.id);
    case EventKind::Leave:
      return detail::handle_leave(state, event.id);
    case EventKind::Link: {
      State next = state;
      push_unexpected(next.unexpected_events, "link");
      return StepResult{next, {}};
    }
    case EventKind::Timer:
      return detail::handle_timer(state, t);
    case EventKind::Budget:
      return detail::handle_budget(state, event, t);
    case EventKind::Report:
      return detail::handle_report(state, event, t);
    case EventKind::KeyframeRequest:
      return detail::handle_keyframe_request(state, event);
  }
  return StepResult{state, {}};
}

}  // namespace wheso::shard
