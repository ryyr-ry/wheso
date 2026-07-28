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
#include <optional>
#include <string>
#include <vector>

#include "wheso/fixed.hpp"
#include "wheso/generated/constants.hpp"
#include "wheso/generated/errors.hpp"
#include "wheso/generated/wire_layout.hpp"
#include "wheso/wire.hpp"

namespace wheso::shard {

/// 輻輳状態（state-machines.md 3 節）。
enum class Congestion { Normal, SheddingT2, SheddingT1, SheddingSpatial, KeyOnly };

/// 状態の名前。トレースの照合と観測で使う。
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

struct Subscription {
  std::int64_t subscriber_id = 0;
  std::int64_t target_id = 0;
  std::int64_t max_spatial_id = 0;
};

/// 受信者ごとの遅延勾配。分子と分母の整数対で持つ（ADR-0017）。
struct ReceiverTrend {
  std::int64_t subscriber_id = 0;
  std::int64_t numerator = 0;
  std::int64_t denominator = 1;
};

struct MaxSpatial {
  std::int64_t from = 0;
  std::int64_t ch = 0;
  std::int64_t sid = 0;
};

/// 送信者 1 人に指令したエンコーダの上限層（ADR-0022）。
struct EncoderTier {
  std::int64_t target_id = 0;
  std::int64_t tier = 0;
};

/// 送信者ごとの直近の発話時刻（ADR-0024）。
struct SpeakerActivity {
  std::int64_t sender_id = 0;
  /// 最後に ACTIVE_SPEAKER=1 の音声が届いた時刻。
  std::int64_t last_speech_at_ms = 0;
};

struct State {
  Congestion congestion = Congestion::Normal;
  std::int64_t congestion_entered_at = 0;
  std::vector<std::int64_t> participants;
  std::vector<Subscription> subscriptions;
  std::int64_t budget_bytes_per_sec = constants::NODE_MAX_OUT_BYTES_PER_SEC;
  std::int64_t sent_bytes_in_window = 0;
  std::int64_t sent_messages_in_window = 0;
  std::int64_t window_start_ms = 0;
  std::vector<std::string> unexpected_events;
  std::vector<ReceiverTrend> trends;
  std::vector<MaxSpatial> max_spatial;
  std::vector<EncoderTier> encoder_tiers;
  /// 送信者ごとの直近の発話時刻。音声の選別転送に使う（ADR-0024）。
  /// sender_id の昇順で保持する（決定性のため）。
  std::vector<SpeakerActivity> speakers;
};

/// 入力イベントの種類。
enum class EventKind { Media, Subscribe, Join, Leave, Link, Timer, Budget, Report };

/// 入力イベント。判別共用体を使わず、種類と欄を平坦に持つ（依存を増やさないため）。
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
  bool want = false;
  std::int64_t max_spatial_id = 0;
  std::int64_t id = 0;
  std::int64_t peer = 0;
  std::string link_state;
  std::int64_t bytes_per_sec = 0;
  std::vector<std::int64_t> delay_us;
};

enum class CommandKind { Forward, Drop, Notify, SetTier };

struct Command {
  CommandKind kind = CommandKind::Forward;
  std::vector<std::int64_t> to;
  std::int64_t priority = 0;
  std::int64_t count = 0;
  std::int64_t code = 0;
  std::int64_t target_id = 0;
  std::int64_t tier = 0;
};

struct StepResult {
  State state;
  std::vector<Command> commands;
};

inline State initial_state(std::int64_t t) {
  State state;
  state.congestion = Congestion::Normal;
  state.congestion_entered_at = t;
  state.budget_bytes_per_sec = constants::NODE_MAX_OUT_BYTES_PER_SEC;
  state.window_start_ms = t;
  return state;
}

namespace detail {

inline State maybe_reset_window(const State& state, std::int64_t t) {
  if (t - state.window_start_ms < constants::SHARD_UTIL_WINDOW_MS) {
    return state;
  }
  State next = state;
  next.sent_bytes_in_window = 0;
  next.sent_messages_in_window = 0;
  next.window_start_ms = t;
  return next;
}

inline State update_max_spatial(const State& state, std::int64_t from, std::int64_t ch, std::int64_t sid) {
  for (const MaxSpatial& entry : state.max_spatial) {
    if (entry.from == from && entry.ch == ch) {
      if (entry.sid >= sid) {
        return state;
      }
      break;
    }
  }
  State next = state;
  next.max_spatial.clear();
  for (const MaxSpatial& entry : state.max_spatial) {
    if (!(entry.from == from && entry.ch == ch)) {
      next.max_spatial.push_back(entry);
    }
  }
  next.max_spatial.push_back(MaxSpatial{from, ch, sid});
  std::sort(next.max_spatial.begin(), next.max_spatial.end(), [](const MaxSpatial& a, const MaxSpatial& b) {
    if (a.from != b.from) {
      return a.from < b.from;
    }
    return a.ch < b.ch;
  });
  return next;
}

inline std::int64_t max_spatial_for(const State& state, std::int64_t from, std::int64_t ch) {
  for (const MaxSpatial& entry : state.max_spatial) {
    if (entry.from == from && entry.ch == ch) {
      return entry.sid;
    }
  }
  return 0;
}

/// 輻輳状態による破棄の判定。破棄禁止（音声とキーフレーム）は常に転送する。
inline bool should_drop_in_congestion(const State& state, std::int64_t sid, std::int64_t tid,
                                      std::int64_t from, std::int64_t ch,
                                      std::optional<std::int64_t> priority) {
  if (!priority.has_value()) {
    return false;
  }
  const std::int64_t value = priority.value();
  switch (state.congestion) {
    case Congestion::Normal:
      return false;
    case Congestion::SheddingT2:
      return value <= 3;
    case Congestion::SheddingT1:
      return tid >= 1;
    case Congestion::SheddingSpatial:
      // (送信者, チャネル) ごとの最大 spatialId のみを破棄する。
      // 全層を破棄すると受信側の復号が完全に止まる。
      return sid >= max_spatial_for(state, from, ch) || tid >= 1;
    case Congestion::KeyOnly:
      return true;
  }
  return false;
}

/// 窓内の予算を超えるか。時刻の差で正規化する（浮動小数点を使わない）。
inline bool is_over_budget(std::int64_t projected_messages, std::int64_t projected_bytes,
                           const State& state, std::int64_t t) {
  const std::int64_t window = t - state.window_start_ms;
  if (window <= 0) {
    return false;
  }
  const bool message_over = projected_messages * 1000 > constants::NODE_MAX_OUT_MESSAGES_PER_SEC * window;
  const bool byte_over = projected_bytes * 1000 > state.budget_bytes_per_sec * window;
  return message_over || byte_over;
}

inline bool util_greater(const State& state, std::int64_t t, std::int64_t num, std::int64_t den) {
  const std::int64_t window = t - state.window_start_ms;
  if (window <= 0) {
    return false;
  }
  return state.sent_messages_in_window * 1000 * den >
         num * window * constants::NODE_MAX_OUT_MESSAGES_PER_SEC;
}

inline bool util_less(const State& state, std::int64_t t, std::int64_t num, std::int64_t den) {
  const std::int64_t window = t - state.window_start_ms;
  if (window <= 0) {
    // 窓が始まっていない場合は利用率 0 とみなす。閾値が正なら下回る。
    return num > 0;
  }
  return state.sent_messages_in_window * 1000 * den <
         num * window * constants::NODE_MAX_OUT_MESSAGES_PER_SEC;
}

/// 1 人でも閾値を超えるか（劣化は OR で評価する）。
inline bool trend_greater(const State& state, std::int64_t num, std::int64_t den) {
  for (const ReceiverTrend& trend : state.trends) {
    if (trend.numerator * den > num * trend.denominator) {
      return true;
    }
  }
  return false;
}

/// 全員が閾値を下回るか（回復は AND で評価する）。記録が無い場合は真とする。
inline bool trend_less(const State& state, std::int64_t num, std::int64_t den) {
  for (const ReceiverTrend& trend : state.trends) {
    if (!(trend.numerator * den < num * trend.denominator)) {
      return false;
    }
  }
  return true;
}

/// 輻輳状態の評価（state-machines.md 3 節）。ヒステリシスの間は遷移しない。
inline StepResult evaluate_congestion(const State& state, std::int64_t t) {
  if (t - state.congestion_entered_at < constants::SHEDDING_HYSTERESIS_MS) {
    return StepResult{state, {}};
  }
  Congestion next_phase = state.congestion;
  switch (state.congestion) {
    case Congestion::Normal:
      if (util_greater(state, t, constants::SHARD_UTIL_ENTER_T2_NUM, constants::SHARD_UTIL_ENTER_T2_DEN) ||
          trend_greater(state, constants::SHARD_TREND_ENTER_T2_NUM, constants::SHARD_TREND_ENTER_T2_DEN)) {
        next_phase = Congestion::SheddingT2;
      }
      break;
    case Congestion::SheddingT2:
      if (util_greater(state, t, constants::SHARD_UTIL_ENTER_T1_NUM, constants::SHARD_UTIL_ENTER_T1_DEN) ||
          trend_greater(state, constants::SHARD_TREND_ENTER_T1_NUM, constants::SHARD_TREND_ENTER_T1_DEN)) {
        next_phase = Congestion::SheddingT1;
      } else if (util_less(state, t, constants::SHARD_UTIL_EXIT_T2_NUM, constants::SHARD_UTIL_EXIT_T2_DEN) &&
                 trend_less(state, constants::SHARD_TREND_EXIT_NUM, constants::SHARD_TREND_EXIT_DEN)) {
        next_phase = Congestion::Normal;
      }
      break;
    case Congestion::SheddingT1:
      if (util_greater(state, t, constants::SHARD_UTIL_ENTER_SPATIAL_NUM,
                       constants::SHARD_UTIL_ENTER_SPATIAL_DEN) ||
          trend_greater(state, constants::SHARD_TREND_ENTER_SPATIAL_NUM,
                        constants::SHARD_TREND_ENTER_SPATIAL_DEN)) {
        next_phase = Congestion::SheddingSpatial;
      } else if (util_less(state, t, constants::SHARD_UTIL_EXIT_T1_NUM, constants::SHARD_UTIL_EXIT_T1_DEN) &&
                 trend_less(state, constants::SHARD_TREND_EXIT_NUM, constants::SHARD_TREND_EXIT_DEN)) {
        next_phase = Congestion::SheddingT2;
      }
      break;
    case Congestion::SheddingSpatial:
      if (util_greater(state, t, constants::SHARD_UTIL_ENTER_KEY_ONLY_NUM,
                       constants::SHARD_UTIL_ENTER_KEY_ONLY_DEN) ||
          trend_greater(state, constants::SHARD_TREND_ENTER_KEY_ONLY_NUM,
                        constants::SHARD_TREND_ENTER_KEY_ONLY_DEN)) {
        next_phase = Congestion::KeyOnly;
      } else if (util_less(state, t, constants::SHARD_UTIL_EXIT_SPATIAL_NUM,
                           constants::SHARD_UTIL_EXIT_SPATIAL_DEN) &&
                 trend_less(state, constants::SHARD_TREND_EXIT_NUM, constants::SHARD_TREND_EXIT_DEN)) {
        next_phase = Congestion::SheddingT1;
      }
      break;
    case Congestion::KeyOnly:
      if (util_less(state, t, constants::SHARD_UTIL_EXIT_KEY_ONLY_NUM,
                    constants::SHARD_UTIL_EXIT_KEY_ONLY_DEN) &&
          trend_less(state, constants::SHARD_TREND_EXIT_KEY_ONLY_NUM,
                     constants::SHARD_TREND_EXIT_KEY_ONLY_DEN)) {
        next_phase = Congestion::SheddingSpatial;
      }
      break;
  }
  if (next_phase == state.congestion) {
    return StepResult{state, {}};
  }
  std::vector<Command> commands;
  if (next_phase == Congestion::KeyOnly) {
    // 過負荷を制御系へ知らせる。接続は閉じない。
    Command notify;
    notify.kind = CommandKind::Notify;
    notify.code = errors::E_NODE_OVERLOADED_CLOSE_CODE;
    commands.push_back(notify);
  }
  State next = state;
  next.congestion = next_phase;
  next.congestion_entered_at = t;
  return StepResult{next, commands};
}

/**
 * 購読の和集合から送信者ごとの必要な上限層を求め、変化した送信者へ setTier を出す。
 * 出力の順序は target_id の昇順に固定する（conformance.md 4.4 の完全一致）。
 */
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
  for (const std::int64_t target_id : targets) {
    std::int64_t tier = 0;
    for (const Subscription& sub : state.subscriptions) {
      if (sub.target_id == target_id && sub.max_spatial_id > tier) {
        tier = sub.max_spatial_id;
      }
    }
    next_tiers.push_back(EncoderTier{target_id, tier});
    bool changed = true;
    for (const EncoderTier& previous : state.encoder_tiers) {
      if (previous.target_id == target_id) {
        changed = previous.tier != tier;
        break;
      }
    }
    // 購読者が居なくなった送信者には指令を出さない（記録のみ除去する）。
    if (changed) {
      Command command;
      command.kind = CommandKind::SetTier;
      command.target_id = target_id;
      command.tier = tier;
      commands.push_back(command);
    }
  }
  State next = state;
  next.encoder_tiers = next_tiers;
  return StepResult{next, commands};
}

/// 音声の選別転送の判断（ADR-0024）。
///
/// 転送対象は「直近に ACTIVE_SPEAKER=1 の音声が届いた時刻」が新しい上位
/// AUDIO_SELECTIVE_FORWARD_COUNT 名である。保持時間の内側に居る発話者だけを候補とし、
/// 時刻が同じ場合は sender_id の昇順とする（決定性のため）。
inline bool is_audio_forwarded(const State& state, std::int64_t sender_id, std::int64_t t) {
  std::vector<SpeakerActivity> active;
  for (const SpeakerActivity& entry : state.speakers) {
    if (t - entry.last_speech_at_ms <= constants::AUDIO_SPEAKER_HOLD_MS) {
      active.push_back(entry);
    }
  }
  if (static_cast<std::int64_t>(active.size()) <= constants::AUDIO_SELECTIVE_FORWARD_COUNT) {
    return true;
  }
  std::stable_sort(active.begin(), active.end(),
                   [](const SpeakerActivity& a, const SpeakerActivity& b) {
                     if (a.last_speech_at_ms != b.last_speech_at_ms) {
                       return a.last_speech_at_ms > b.last_speech_at_ms;
                     }
                     return a.sender_id < b.sender_id;
                   });
  const std::size_t limit =
      static_cast<std::size_t>(constants::AUDIO_SELECTIVE_FORWARD_COUNT);
  for (std::size_t index = 0; index < active.size() && index < limit; ++index) {
    if (active[index].sender_id == sender_id) {
      return true;
    }
  }
  return false;
}

/// 発話の記録を更新する。sender_id の昇順を保つ（決定性のため）。
inline std::vector<SpeakerActivity> record_speech(const std::vector<SpeakerActivity>& speakers,
                                                 std::int64_t sender_id, std::int64_t t) {
  std::vector<SpeakerActivity> updated;
  bool replaced = false;
  for (const SpeakerActivity& entry : speakers) {
    if (entry.sender_id == sender_id) {
      updated.push_back(SpeakerActivity{sender_id, t});
      replaced = true;
      continue;
    }
    updated.push_back(entry);
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

inline StepResult handle_media(const State& state, const Event& event, std::int64_t t) {
  const State windowed = maybe_reset_window(state, t);
  State next = update_max_spatial(windowed, event.from, event.ch, event.sid);

  // 音声で ACTIVE_SPEAKER が立っていれば発話時刻を記録する（選別転送。ADR-0024）。
  // 記録は選別の前に行う。今まさに発話している者の音声は通す必要がある。
  const bool is_audio = event.ch == static_cast<std::int64_t>(wire_layout::CHANNEL_AUDIO);
  const bool is_speaking =
      (event.flags & static_cast<std::int64_t>(wire_layout::FLAG_ACTIVE_SPEAKER)) != 0;
  if (is_audio && is_speaking) {
    next.speakers = record_speech(next.speakers, event.from, t);
  }

  // 上限に入らない送信者の音声は破棄する。輻輳ではないため priority は 0 とする。
  if (is_audio && !is_audio_forwarded(next, event.from, t)) {
    Command selective;
    selective.kind = CommandKind::Drop;
    selective.priority = 0;
    selective.count = 1;
    return StepResult{next, {selective}};
  }

  const std::optional<std::uint8_t> raw_priority =
      drop_priority(static_cast<std::uint8_t>(event.ch), static_cast<std::uint8_t>(event.flags));
  std::optional<std::int64_t> priority;
  if (raw_priority.has_value()) {
    priority = static_cast<std::int64_t>(raw_priority.value());
  }

  if (should_drop_in_congestion(next, event.sid, event.tid, event.from, event.ch, priority)) {
    Command drop;
    drop.kind = CommandKind::Drop;
    drop.priority = priority.has_value() ? priority.value() : 0;
    drop.count = 1;
    return StepResult{next, {drop}};
  }

  std::vector<std::int64_t> targets;
  for (const Subscription& sub : next.subscriptions) {
    if (sub.target_id == event.from && event.sid <= sub.max_spatial_id) {
      targets.push_back(sub.subscriber_id);
    }
  }
  std::sort(targets.begin(), targets.end());

  if (targets.empty()) {
    return StepResult{next, {}};
  }

  const std::int64_t msg_cost = static_cast<std::int64_t>(targets.size());
  const std::int64_t byte_cost = msg_cost * event.bytes;
  const std::int64_t projected_messages = next.sent_messages_in_window + msg_cost;
  const std::int64_t projected_bytes = next.sent_bytes_in_window + byte_cost;

  if (is_over_budget(projected_messages, projected_bytes, next, t) && priority.has_value()) {
    Command drop;
    drop.kind = CommandKind::Drop;
    drop.priority = priority.value();
    drop.count = 1;
    return StepResult{next, {drop}};
  }

  State after = next;
  after.sent_bytes_in_window = next.sent_bytes_in_window + byte_cost;
  after.sent_messages_in_window = next.sent_messages_in_window + msg_cost;
  StepResult evaluated = evaluate_congestion(after, t);

  Command forward;
  forward.kind = CommandKind::Forward;
  forward.to = targets;
  std::vector<Command> commands;
  commands.push_back(forward);
  for (const Command& command : evaluated.commands) {
    commands.push_back(command);
  }
  return StepResult{evaluated.state, commands};
}

inline StepResult handle_subscribe(const State& state, const Event& event) {
  State next = state;
  next.subscriptions.clear();
  for (const Subscription& sub : state.subscriptions) {
    if (!(sub.subscriber_id == event.from && sub.target_id == event.to)) {
      next.subscriptions.push_back(sub);
    }
  }
  if (event.want) {
    next.subscriptions.push_back(Subscription{event.from, event.to, event.max_spatial_id});
    std::sort(next.subscriptions.begin(), next.subscriptions.end(),
              [](const Subscription& a, const Subscription& b) {
                if (a.subscriber_id != b.subscriber_id) {
                  return a.subscriber_id < b.subscriber_id;
                }
                return a.target_id < b.target_id;
              });
  }
  return with_encoder_tiers(next);
}

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
  for (const std::int64_t value : state.participants) {
    if (value != id) {
      next.participants.push_back(value);
    }
  }
  next.subscriptions.clear();
  for (const Subscription& sub : state.subscriptions) {
    if (sub.subscriber_id != id && sub.target_id != id) {
      next.subscriptions.push_back(sub);
    }
  }
  // 退出者の遅延勾配と観測した spatialId も除去する。
  // 残すと、居なくなった相手の古い観測が輻輳の判定に影響し続ける。
  next.trends.clear();
  for (const ReceiverTrend& trend : state.trends) {
    if (trend.subscriber_id != id) {
      next.trends.push_back(trend);
    }
  }
  next.max_spatial.clear();
  for (const MaxSpatial& entry : state.max_spatial) {
    if (entry.from != id) {
      next.max_spatial.push_back(entry);
    }
  }
  // 退出者への指令の記録も除去する。残すと再参加時に指令が出ない。
  next.encoder_tiers.clear();
  for (const EncoderTier& entry : state.encoder_tiers) {
    if (entry.target_id != id) {
      next.encoder_tiers.push_back(entry);
    }
  }
  return with_encoder_tiers(next);
}

inline StepResult handle_report(const State& state, const Event& event, std::int64_t t) {
  const Slope slope = delay_slope(event.delay_us);
  State next = state;
  next.trends.clear();
  for (const ReceiverTrend& trend : state.trends) {
    if (trend.subscriber_id != event.from) {
      next.trends.push_back(trend);
    }
  }
  next.trends.push_back(ReceiverTrend{event.from, slope.numerator, slope.denominator});
  std::sort(next.trends.begin(), next.trends.end(), [](const ReceiverTrend& a, const ReceiverTrend& b) {
    return a.subscriber_id < b.subscriber_id;
  });
  return evaluate_congestion(next, t);
}

}  // namespace detail

/// 1 ステップの状態遷移。
inline StepResult step(const State& state, const Event& event, std::int64_t t) {
  switch (event.kind) {
    case EventKind::Media:
      return detail::handle_media(state, event, t);
    case EventKind::Subscribe:
      return detail::handle_subscribe(state, event);
    case EventKind::Join:
      return detail::handle_join(state, event.id);
    case EventKind::Leave:
      return detail::handle_leave(state, event.id);
    case EventKind::Link: {
      // 表に無いイベントは無視して記録する。
      State next = state;
      next.unexpected_events.push_back("link");
      return StepResult{next, {}};
    }
    case EventKind::Timer:
      return detail::evaluate_congestion(detail::maybe_reset_window(state, t), t);
    case EventKind::Budget: {
      State next = state;
      next.budget_bytes_per_sec = event.bytes_per_sec;
      return detail::evaluate_congestion(next, t);
    }
    case EventKind::Report:
      return detail::handle_report(state, event, t);
  }
  return StepResult{state, {}};
}

}  // namespace wheso::shard
